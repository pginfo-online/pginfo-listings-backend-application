'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { Resend } = require('resend');
const Otp = require('../models/Otp.model');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure 4-digit numeric OTP
 * @returns {string} 4-digit string
 */
const generateOtp = () => crypto.randomInt(1000, 10000).toString();

/**
 * Build the throttle-aware error for rate limiting
 */
const buildRateLimitError = (message, statusCode = 429, retryAfter = 0) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.retryAfter = retryAfter; // seconds until user can retry
  return error;
};

// ─────────────────────────────────────────────────────────────────────────────
// Channel 1 — Email via Resend
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send OTP email using Resend
 * @param {string} email
 * @param {string} otpCode
 * @param {'login'|'register'|'unified'} purpose
 */
const sendOtpEmail = async (email, otpCode, purpose = 'login') => {
  const emailLower = email.toLowerCase().trim();

  if (!process.env.RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY is not defined in environment variables.');
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'developement'
    ) {
      logger.info(`[DEV FALLBACK] Email OTP for ${emailLower}: ${otpCode}`);
      return { success: true, devFallback: true };
    }
    throw Object.assign(
      new Error('Email service configuration missing. Contact administrator.'),
      { statusCode: 500 }
    );
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const subject =
    purpose === 'register'
      ? 'Verify your email — PGinfo.online'
      : 'Your Login OTP — PGinfo.online';
  const actionText =
    purpose === 'register' ? 'creating your account' : 'signing in';

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8fafc; padding: 32px 20px;">
      <div style="background: #fff; border-radius: 16px; padding: 36px 32px; box-shadow: 0 4px 24px rgba(0,0,0,0.07);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #4f46e5; font-size: 26px; font-weight: 800; margin: 0; letter-spacing: -0.5px;">PGinfo.online</h1>
          <p style="color: #6b7280; font-size: 13px; margin-top: 4px;">Find your perfect PG, zero brokerage</p>
        </div>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 24px;" />
        <p style="color: #374151; font-size: 15px; margin: 0 0 8px;">Hello,</p>
        <p style="color: #6b7280; font-size: 14px; margin: 0 0 24px;">
          You requested a One-Time Password (OTP) for <strong>${actionText}</strong> on PGinfo.online.
        </p>
        <div style="background: linear-gradient(135deg, #eef2ff, #f5f3ff); border: 2px dashed #c7d2fe; border-radius: 12px; text-align: center; padding: 24px 20px; margin: 0 0 24px;">
          <p style="color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px;">Your OTP Code</p>
          <span style="font-size: 42px; font-weight: 900; letter-spacing: 12px; color: #4f46e5;">${otpCode}</span>
        </div>
        <p style="color: #4b5563; font-size: 13px; line-height: 1.6; margin: 0 0 12px;">
          This code is valid for <strong>5 minutes</strong>. If you did not request this code, please ignore this email.
        </p>
        <p style="color: #ef4444; font-size: 12px; font-weight: 700; margin: 0 0 24px;">
          ⚠️ Never share this OTP with anyone — our team will never ask for it.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0 0 16px;" />
        <p style="color: #9ca3af; font-size: 11px; text-align: center; margin: 0;">
          This is an automated message. Please do not reply.<br />
          © ${new Date().getFullYear()} PGinfo.online. All rights reserved.
        </p>
      </div>
    </div>
  `;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: `PGinfo.online <${fromEmail}>`,
      to: emailLower,
      subject,
      html,
    });
    logger.info(`OTP email sent to ${emailLower} for "${purpose}"`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to send OTP email to ${emailLower}: ${err.message}`);
    throw Object.assign(
      new Error('Failed to send verification email. Please try again.'),
      { statusCode: 500 }
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Channel 2 — SMS via Dreamz Technology — GET API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build and send an SMS via Dreamz Technology HTTP GET API
 * @param {string} phone - 10-digit Indian mobile number
 * @param {string} otpCode
 * @returns {Promise<{ success: boolean, messageId?: string, phone: string, devFallback?: boolean }>}
 */
const sendOtpSms = async (phone, otpCode) => {
  const baseUrl =
    process.env.SMS_BASE_URL ||
    'http://trans.dreamztechnolgy.org/smsstatuswithid.aspx';

  const mobile = process.env.SMS_USER_MOBILE || process.env.SMS_MOBILE;
  const pass = process.env.SMS_PASSWORD;
  const apiKey = process.env.SMS_API_KEY;
  const senderId = process.env.SMS_SENDER_ID || 'PGINF';
  const peid = process.env.SMS_PEID;
  const templateId = process.env.SMS_TEMPLATE_ID;

  // -------------------------------------------------------
  // 1. Validate configuration
  // -------------------------------------------------------

  if (!baseUrl || !mobile || !pass || !apiKey || !senderId || !peid || !templateId) {
    logger.warn('SMS provider credentials are not configured in environment variables.');

    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'developement'
    ) {
      logger.info(
        `[DEV FALLBACK] SMS OTP for ${phone}: ${otpCode}`
      );

      return {
        success: true,
        devFallback: true,
        phone: String(phone),
      };
    }

    throw Object.assign(
      new Error(
        'SMS service configuration missing. Contact administrator.'
      ),
      {
        statusCode: 500,
      }
    );
  }

  // -------------------------------------------------------
  // 2. Normalize phone number (Destination "to")
  // -------------------------------------------------------

  let normalizedPhone = String(phone).replace(/\D/g, '');

  // Strip international / trunk prefixes to obtain 10-digit Indian mobile number
  if (normalizedPhone.length === 12 && normalizedPhone.startsWith('91')) {
    normalizedPhone = normalizedPhone.slice(2);
  } else if (normalizedPhone.length === 11 && normalizedPhone.startsWith('0')) {
    normalizedPhone = normalizedPhone.slice(1);
  }

  if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
    throw Object.assign(
      new Error('Invalid Indian mobile number. Enter a valid 10-digit mobile number.'),
      {
        statusCode: 400,
      }
    );
  }

  // -------------------------------------------------------
  // 3. Validate OTP
  // -------------------------------------------------------

  const otp = String(otpCode).trim();

  if (!/^\d{4}$/.test(otp)) {
    throw Object.assign(
      new Error('OTP must be exactly 4 digits.'),
      {
        statusCode: 400,
      }
    );
  }

  // -------------------------------------------------------
  // 4. Exact SMS Template
  // -------------------------------------------------------
  // Approved template:
  // Dear User, PGInfo login verification code is {OTP}. This OTP is valid for 5 minutes. Do not share this OTP with anyone. - PGInfo

  const message =
    `Dear User, PGInfo login verification code is ${otp}. This OTP is valid for 5 minutes. Do not share this OTP with anyone. - PGInfo`;

  // -------------------------------------------------------
  // 5. Build request parameters
  // -------------------------------------------------------

  const params = {
    mobile,
    pass,
    to: normalizedPhone,
    msg: message,
    peid,
    templateid: templateId,
    restype: 'json',
    apikey: apiKey,
    senderid: senderId,
  };

  // -------------------------------------------------------
  // 6. Send SMS
  // -------------------------------------------------------

  try {
    const response = await axios.get(baseUrl, {
      params,
      timeout: 15000,
    });

    let responseData = response.data;
    if (typeof responseData === 'string') {
      try {
        responseData = JSON.parse(responseData.trim());
      } catch {
        // Plain text fallback if provider response is not valid JSON
      }
    }

    // -----------------------------------------------------
    // 7. Handle empty response
    // -----------------------------------------------------

    if (!responseData) {
      throw Object.assign(
        new Error('SMS provider returned an empty response.'),
        {
          statusCode: 502,
        }
      );
    }

    // -----------------------------------------------------
    // 8. Validate Provider Response Status
    // -----------------------------------------------------
    // Expected Success Response:
    // { "status": "000", "statusdesc": "success", "messageid": "..." }

    const statusCode = responseData.status != null ? String(responseData.status).trim() : null;
    const isSuccess = statusCode === '000';

    if (!isSuccess) {
      const statusDesc =
        responseData.statusdesc ||
        (typeof responseData === 'string' ? responseData : 'Unknown error');

      logger.error(
        `SMS provider returned error for ${normalizedPhone}: status=${statusCode || 'unknown'}, desc=${statusDesc}`
      );

      throw Object.assign(
        new Error(`SMS gateway error: ${statusDesc}`),
        {
          statusCode: 502,
          providerStatus: statusCode,
          providerDesc: statusDesc,
        }
      );
    }

    // -----------------------------------------------------
    // 9. Successful SMS submission
    // -----------------------------------------------------

    const messageId =
      responseData.messageid != null
        ? String(responseData.messageid).trim()
        : undefined;

    logger.info(
      `SMS submitted successfully. ` +
      `Phone: ${normalizedPhone}, ` +
      `Message ID: ${messageId}`
    );

    return {
      success: true,
      messageId,
      phone: normalizedPhone,
    };
  } catch (err) {
    // Re-throw our own application errors
    if (err.statusCode) {
      throw err;
    }

    // Axios / network / timeout error
    const providerResponse =
      err.response?.data ?? err.message;

    logger.error(
      `SMS request failed for ${normalizedPhone}:`,
      providerResponse
    );

    throw Object.assign(
      new Error(
        'Failed to send verification SMS. Please try again.'
      ),
      {
        statusCode: 502,
      }
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Channel 3 — WhatsApp via Ping4SMS (route=6) + Meta fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send OTP via WhatsApp using Meta Business API (preferred) or Ping4SMS (fallback)
 * Falls back gracefully — never throws; logs errors only.
 * @param {string} phone - 10-digit or 12-digit Indian mobile number
 * @param {string} otpCode
 * @returns {{ success: boolean, channel: 'whatsapp', messageId?: string, error?: string }}
 */
const sendOtpWhatsApp = async (phone, otpCode) => {
  // 1. Check for Meta WhatsApp Business API credentials
  const metaAccessToken = process.env.META_WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const metaPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const metaTemplateName = process.env.META_WHATSAPP_TEMPLATE_NAME || process.env.WHATSAPP_TEMPLATE_NAME || 'pginfo_login_otp';
  const metaTemplateLang = process.env.META_WHATSAPP_TEMPLATE_LANG || process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';

  // Normalize phone to E.164-like format (e.g. 91XXXXXXXXXX) for Meta API and consistent fallback
  let normalizedPhone = String(phone).replace(/\D/g, '');
  if (normalizedPhone.length === 10) {
    normalizedPhone = `91${normalizedPhone}`;
  }
  if (normalizedPhone.startsWith('0') && normalizedPhone.length === 11) {
    normalizedPhone = `91${normalizedPhone.substring(1)}`;
  }

  if (metaAccessToken && metaPhoneNumberId) {
    if (!normalizedPhone.startsWith('91') || normalizedPhone.length !== 12) {
      logger.error(`Invalid phone number for Meta WhatsApp: ${phone}`);
      return { success: false, channel: 'whatsapp', error: 'Invalid phone number format' };
    }

    const url = `https://graph.facebook.com/v25.0/${metaPhoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: normalizedPhone,
      type: 'template',
      template: {
        name: metaTemplateName,
        language: {
          code: metaTemplateLang,
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: otpCode,
              },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              {
                type: 'text',
                text: otpCode,
              },
            ],
          },
        ],
      },
    };

    try {
      logger.info(`Sending Meta WhatsApp OTP to ${normalizedPhone} using template ${metaTemplateName}`);
      const response = await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${metaAccessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const data = response.data;
      if (data && data.messages && data.messages.length > 0) {
        logger.info(`Meta WhatsApp OTP sent successfully. Msg ID: ${data.messages[0].id}`);
        return {
          success: true,
          channel: 'whatsapp',
          messageId: data.messages[0].id,
        };
      } else {
        logger.warn(`Meta WhatsApp API returned unexpected response format: ${JSON.stringify(data)}`);
        return {
          success: false,
          channel: 'whatsapp',
          error: 'Unexpected response format from Meta API',
        };
      }
    } catch (err) {
      const errorData = err.response?.data?.error;
      const errorMsg = errorData?.message || err.message;
      const errorCode = errorData?.code;
      const errorType = errorData?.type;
      const fbTraceId = errorData?.fbtrace_id;
      
      logger.error(
        `Meta WhatsApp API delivery failed for ${normalizedPhone}. ` +
        `Error: ${errorMsg} (Code: ${errorCode}, Type: ${errorType}, TraceID: ${fbTraceId})`
      );
      return {
        success: false,
        channel: 'whatsapp',
        error: `Meta API Error: ${errorMsg} (Code: ${errorCode})`,
      };
    }
  }

  // 2. Fall back to Ping4SMS route=6
  const baseUrl = process.env.PING4SMS_BASE_URL;
  const apiKey = process.env.PING4SMS_API_KEY;
  const senderId = process.env.PING4SMS_WHATSAPP_SENDER_ID || process.env.PING4SMS_SENDER_ID;
  const route = process.env.PING4SMS_WHATSAPP_ROUTE || '6';
  const templateId = process.env.PING4SMS_WHATSAPP_TEMPLATE_ID;

  if (!baseUrl || !apiKey || !senderId) {
    logger.warn('WhatsApp credentials (Meta & Ping4SMS) not configured — skipping WhatsApp delivery.');
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'developement'
    ) {
      logger.info(`[DEV FALLBACK] WhatsApp OTP for ${normalizedPhone}: ${otpCode}`);
      return { success: true, channel: 'whatsapp', devFallback: true };
    }
    return { success: false, channel: 'whatsapp', error: 'WhatsApp configuration missing' };
  }

  const message =
    `🔐 *PGinfo.online OTP*\n\n` +
    `Your one-time password is: *${otpCode}*\n\n` +
    `Valid for *5 minutes*. Do NOT share this code with anyone.\n\n` +
    `_This is an automated message from PGinfo.online_`;

  const params = new URLSearchParams({
    key: apiKey,
    route,
    sender: senderId,
    number: normalizedPhone,
    sms: message,
    ...(templateId &&
      templateId !== 'YOUR_WHATSAPP_DLT_TEMPLATE_ID_HERE' && { templateid: templateId }),
  });

  const url = `${baseUrl}?${params.toString()}`;

  try {
    const response = await axios.get(url, { timeout: 15000 });
    const responseData = response.data?.toString().trim();

    if (responseData && /^1\d{2}$/.test(responseData)) {
      logger.warn(`Ping4SMS WhatsApp error for ${normalizedPhone}: code ${responseData}`);
      return { success: false, channel: 'whatsapp', error: `Gateway error ${responseData}` };
    }

    logger.info(`WhatsApp OTP sent to ${normalizedPhone} via Ping4SMS. Message ID: ${responseData}`);
    return { success: true, channel: 'whatsapp', messageId: responseData };
  } catch (err) {
    logger.error(
      `WhatsApp delivery failed via Ping4SMS for ${normalizedPhone}: ${err.response?.data || err.message}`
    );
    // Graceful — don't throw; SMS was already sent
    return { success: false, channel: 'whatsapp', error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OTP CRUD — shared throttling helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply throttle checks (60s cooldown + 5/15min cap) for a given query
 */
const applyOtpThrottle = async (query, purpose) => {
  const COOLDOWN_MS = 60_000;
  const WINDOW_MS = 15 * 60_000;
  const MAX_PER_WINDOW = 5;

  const latestOtp = await Otp.findOne({ ...query, purpose }).sort({ createdAt: -1 });
  if (latestOtp && Date.now() - latestOtp.createdAt.getTime() < COOLDOWN_MS) {
    const remaining = Math.ceil(
      (COOLDOWN_MS - (Date.now() - latestOtp.createdAt.getTime())) / 1000
    );
    throw buildRateLimitError(
      `Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before requesting a new OTP.`,
      429,
      remaining  // ← retryAfter in seconds passed to client
    );
  }

  const windowStart = new Date(Date.now() - WINDOW_MS);
  const recentCount = await Otp.countDocuments({
    ...query,
    purpose,
    createdAt: { $gte: windowStart },
  });
  if (recentCount >= MAX_PER_WINDOW) {
    throw buildRateLimitError(
      'Too many OTP requests. Please try again in 15 minutes.',
      429,
      900 // 15 min in seconds
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// createOtp — email-only legacy flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and send OTP for standard email flows (register / login)
 * @param {string} email
 * @param {'register'|'login'} purpose
 */
const createOtp = async (email, purpose) => {
  const emailLower = email.toLowerCase().trim();
  const query = { email: emailLower };

  await applyOtpThrottle(query, purpose);

  const otpCode = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60_000);

  await Otp.create({ email: emailLower, otp: otpCode, purpose, expiresAt });
  await sendOtpEmail(emailLower, otpCode, purpose);

  return { success: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// createOtpUnified — multi-channel: email | phone (SMS + optional WhatsApp)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and send OTP for unified flow (email or phone).
 * When phone is supplied:
 *   - Always sends SMS
 *   - Also sends WhatsApp (Meta / WhatsApp fallback) if sendWhatsApp=true (default)
 *
 * @param {{ email?: string, phone?: string, sendWhatsApp?: boolean }} options
 * @returns {{ success: boolean, channels: string[] }}
 */
const createOtpUnified = async ({ email, phone, sendWhatsApp = true }) => {
  const identifier = email || phone;
  if (!identifier) {
    throw Object.assign(new Error('Email or phone number is required'), { statusCode: 400 });
  }

  let emailNorm = email ? email.toLowerCase().trim() : undefined;
  let phoneNorm = phone ? phone.trim() : undefined;

  // Validate and normalize email
  if (emailNorm) {
    const isEmail = /\S+@\S+\.\S+/.test(emailNorm);
    if (!isEmail) {
      throw Object.assign(new Error('Invalid email address format.'), { statusCode: 400 });
    }
  }

  // Validate and normalize phone to 10-digit format for consistent query and DB storage
  if (phoneNorm) {
    const digits = phoneNorm.replace(/\D/g, '');
    let parsed10Digits = '';

    if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
      parsed10Digits = digits;
    } else if (digits.length === 11 && digits.startsWith('0') && /^[6-9]\d{9}$/.test(digits.slice(1))) {
      parsed10Digits = digits.slice(1);
    } else if (digits.length === 12 && digits.startsWith('91') && /^[6-9]\d{9}$/.test(digits.slice(2))) {
      parsed10Digits = digits.slice(2);
    }

    if (!parsed10Digits) {
      throw Object.assign(
        new Error('Invalid Indian mobile number. Enter a valid 10-digit mobile number.'),
        { statusCode: 400 }
      );
    }
    phoneNorm = parsed10Digits;
  }

  const query = emailNorm ? { email: emailNorm } : { phone: phoneNorm };

  await applyOtpThrottle(query, 'unified');

  const otpCode = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60_000);

  await Otp.create({ ...query, otp: otpCode, purpose: 'unified', expiresAt });

  const channels = [];
  const deliveryErrors = [];

  if (emailNorm) {
    // ── Email channel ──────────────────────────────────────────────────────
    await sendOtpEmail(emailNorm, otpCode, 'unified');
    channels.push('email');
  }

  if (phoneNorm) {
    // ── SMS channel (always, if phone provided) ────────────────────────────
    try {
      await sendOtpSms(phoneNorm, otpCode);
      channels.push('sms');
    } catch (smsErr) {
      logger.error(`SMS delivery failed for ${phoneNorm}: ${smsErr.message}`);
      deliveryErrors.push({ channel: 'sms', error: smsErr.message });
    }

    // ── WhatsApp channel (optional, simultaneous, non-blocking) ───────────
    if (sendWhatsApp) {
      const waResult = await sendOtpWhatsApp(phoneNorm, otpCode);
      if (waResult.success) {
        channels.push('whatsapp');
      } else {
        deliveryErrors.push({ channel: 'whatsapp', error: waResult.error });
      }
    }

    // If ALL phone channels failed, surface the error to the caller
    const phoneChannels = channels.filter((c) => c === 'sms' || c === 'whatsapp');
    if (phoneChannels.length === 0) {
      throw Object.assign(
        new Error('Failed to deliver OTP. Please try again.'),
        { statusCode: 500 }
      );
    }
  }

  if (deliveryErrors.length > 0) {
    logger.warn(`Some OTP channels failed: ${JSON.stringify(deliveryErrors)}`);
  }

  logger.info(`OTP created and sent via: ${channels.join(', ')} for ${identifier}`);
  return { success: true, channels };
};

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtpUnified
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify OTP in the unified flow (email or phone)
 * @param {{ email?: string, phone?: string, otp: string }}
 * @returns {true}
 * @throws on invalid / expired / too-many-attempts
 */
const verifyOtpUnified = async ({ email, phone, otp }) => {
  const emailNorm = email ? email.toLowerCase().trim() : undefined;
  const phoneNorm = phone ? phone.trim() : undefined;
  const query = emailNorm ? { email: emailNorm } : { phone: phoneNorm };

  const otpRecord = await Otp.findOne({
    ...query,
    purpose: 'unified',
    verified: false,
  }).sort({ createdAt: -1 });

  if (!otpRecord) {
    throw Object.assign(
      new Error('OTP not found. Please request a new OTP.'),
      { statusCode: 404 }
    );
  }
  if (otpRecord.expiresAt < new Date()) {
    throw Object.assign(
      new Error('OTP has expired. Please request a new OTP.'),
      { statusCode: 400 }
    );
  }
  if (otpRecord.attempts >= 5) {
    throw Object.assign(
      new Error('Too many incorrect attempts. Please request a new OTP.'),
      { statusCode: 400 }
    );
  }

  otpRecord.attempts += 1;
  if (otpRecord.otp !== otp) {
    await otpRecord.save();
    const remaining = 5 - otpRecord.attempts;
    throw Object.assign(
      new Error(`Invalid OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`),
      { statusCode: 400 }
    );
  }

  otpRecord.verified = true;
  await otpRecord.save();
  logger.info(`OTP verified successfully for ${emailNorm || phoneNorm}`);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtp — legacy email-only flow (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify standard email OTP (register / login)
 * @param {string} email
 * @param {'register'|'login'} purpose
 * @param {string} otp
 */
const verifyOtp = async (email, purpose, otp) => {
  const emailLower = email.toLowerCase().trim();

  const otpRecord = await Otp.findOne({
    email: emailLower,
    purpose,
    verified: false,
  }).sort({ createdAt: -1 });

  if (!otpRecord) {
    throw Object.assign(
      new Error('OTP not found. Please request a new OTP.'),
      { statusCode: 404 }
    );
  }
  if (otpRecord.expiresAt < new Date()) {
    throw Object.assign(
      new Error('OTP has expired. Please request a new OTP.'),
      { statusCode: 400 }
    );
  }
  if (otpRecord.attempts >= 5) {
    throw Object.assign(
      new Error('Too many incorrect attempts. Please request a new OTP.'),
      { statusCode: 400 }
    );
  }

  otpRecord.attempts += 1;
  if (otpRecord.otp !== otp) {
    await otpRecord.save();
    const remaining = 5 - otpRecord.attempts;
    throw Object.assign(
      new Error(`Invalid OTP. You have ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`),
      { statusCode: 400 }
    );
  }

  otpRecord.verified = true;
  await otpRecord.save();
  logger.info(`OTP verified for ${emailLower} (${purpose})`);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  generateOtp,
  sendOtpEmail,
  sendOtpSms,
  sendOtpWhatsApp,
  createOtp,
  verifyOtp,
  createOtpUnified,
  verifyOtpUnified,
};