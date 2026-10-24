'use strict';

require('dotenv').config();
const assert = require('assert');
const { connectDB } = require('../config/db');
const Otp = require('../models/Otp.model');
const otpService = require('../services/otp.service');
const { sendOtpUnified, verifyOtpUnified } = require('../controllers/auth.controller');

const TEST_PHONE = '8010097706';

// Helper mock response
const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
};

// Helper mock request invocation
const invokeHandler = async (handler, req, res) => {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const next = (err) => {
      if (err) {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      }
    };

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      originalJson(body);
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
      return res;
    };

    try {
      const p = handler(req, res, next);
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (!resolved && res.body !== null) {
            resolved = true;
            resolve(res);
          }
        }).catch((err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      }
    } catch (err) {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    }
  });
};

const runIntegrationTests = async () => {
  console.log('==================================================================');
  console.log('🧪 Starting SMS Provider Integration & OTP Flow Verification Tests');
  console.log(`📱 Test Phone Number: ${TEST_PHONE}`);
  console.log('==================================================================\n');

  // Connect to DB
  console.log('👉 [1/6] Connecting to MongoDB Database...');
  await connectDB();
  console.log('  ✓ Connected to Database.\n');

  // Clean any previous test OTPs for TEST_PHONE to avoid throttle cooldown
  await Otp.deleteMany({ phone: TEST_PHONE });

  // TEST 1: sendOtpSms direct invocation
  console.log('👉 [2/6] Testing sendOtpSms directly with real provider API...');
  const directOtp = otpService.generateOtp();
  console.log(`  Generated OTP: ${directOtp}`);
  const directResult = await otpService.sendOtpSms(TEST_PHONE, directOtp);
  console.log('  Actual Provider Result:', JSON.stringify(directResult, null, 2));

  assert.strictEqual(directResult.success, true, 'sendOtpSms must return success: true');
  assert.ok(directResult.messageId, 'sendOtpSms must return a provider messageId');
  assert.strictEqual(directResult.phone, TEST_PHONE, 'sendOtpSms must return normalized phone');
  console.log(`  ✓ Provider accepted SMS successfully. Message ID: ${directResult.messageId}\n`);

  // TEST 2: sendOtpSms input validation
  console.log('👉 [3/6] Testing sendOtpSms input validation...');
  await assert.rejects(
    async () => otpService.sendOtpSms(TEST_PHONE, '12'),
    (err) => err.statusCode === 400 && /4 digits/.test(err.message),
    'Rejects invalid OTP length'
  );
  console.log('  ✓ Rejected invalid OTP (< 4 digits)');

  await assert.rejects(
    async () => otpService.sendOtpSms('12345', directOtp),
    (err) => err.statusCode === 400 && /Indian mobile number/.test(err.message),
    'Rejects invalid mobile number'
  );
  console.log('  ✓ Rejected invalid mobile number\n');

  // Clean again to prevent cooldown before createOtpUnified
  await Otp.deleteMany({ phone: TEST_PHONE });

  // TEST 3: createOtpUnified flow
  console.log('👉 [4/6] Testing createOtpUnified service integration...');
  const serviceResult = await otpService.createOtpUnified({
    phone: TEST_PHONE,
    sendWhatsApp: false,
  });
  console.log('  createOtpUnified result:', JSON.stringify(serviceResult, null, 2));

  assert.strictEqual(serviceResult.success, true, 'createOtpUnified returns success: true');
  assert.ok(serviceResult.channels.includes('sms'), 'createOtpUnified channels include "sms"');

  const createdOtpRecord = await Otp.findOne({
    phone: TEST_PHONE,
    purpose: 'unified',
    verified: false,
  }).sort({ createdAt: -1 });

  assert.ok(createdOtpRecord, 'OTP record saved in database');
  assert.strictEqual(createdOtpRecord.otp.length, 4, 'Saved OTP is 4 digits');
  assert.strictEqual(createdOtpRecord.verified, false, 'Saved OTP verified is initially false');
  console.log(`  ✓ Database record verified. OTP stored: ${createdOtpRecord.otp}\n`);

  // TEST 4: verifyOtpUnified service
  console.log('👉 [5/6] Testing verifyOtpUnified with invalid and valid OTP...');
  await assert.rejects(
    async () => otpService.verifyOtpUnified({ phone: TEST_PHONE, otp: '9999' }),
    (err) => err.statusCode === 400 && /Invalid OTP/.test(err.message),
    'Rejects invalid OTP code'
  );
  console.log('  ✓ Rejected invalid OTP');

  const verifySuccess = await otpService.verifyOtpUnified({
    phone: TEST_PHONE,
    otp: createdOtpRecord.otp,
  });
  assert.strictEqual(verifySuccess, true, 'verifyOtpUnified returns true');

  const updatedRecord = await Otp.findById(createdOtpRecord._id);
  assert.strictEqual(updatedRecord.verified, true, 'OTP record is now marked verified: true');
  console.log('  ✓ OTP verified successfully in database.\n');

  // Clean again before testing controller
  await Otp.deleteMany({ phone: TEST_PHONE });

  // TEST 5: Controller end-to-end flow
  console.log('👉 [6/6] Testing controller handlers (sendOtpUnified & verifyOtpUnified)...');
  const mockSendReq = {
    body: {
      contact: TEST_PHONE,
      type: 'phone',
      sendWhatsApp: false,
    },
  };
  const mockSendRes = createMockRes();
  await invokeHandler(sendOtpUnified, mockSendReq, mockSendRes);

  console.log('  Controller send response:', JSON.stringify(mockSendRes.body, null, 2));
  assert.strictEqual(mockSendRes.statusCode, 200, 'sendOtpUnified returns HTTP 200');
  assert.strictEqual(mockSendRes.body?.success, true, 'sendOtpUnified response.success is true');
  assert.ok(mockSendRes.body?.data?.channels.includes('sms'), 'Response channels include sms');

  const dbOtp = await Otp.findOne({
    phone: TEST_PHONE,
    purpose: 'unified',
    verified: false,
  }).sort({ createdAt: -1 });
  assert.ok(dbOtp, 'OTP found in DB for controller test');
  console.log(`  Controller sent OTP: ${dbOtp.otp}`);

  const mockVerifyReq = {
    body: {
      contact: TEST_PHONE,
      otp: dbOtp.otp,
      isMobile: false,
    },
  };
  const mockVerifyRes = createMockRes();
  await invokeHandler(verifyOtpUnified, mockVerifyReq, mockVerifyRes);

  console.log('  Controller verify response:', JSON.stringify(mockVerifyRes.body, null, 2));
  assert.strictEqual(mockVerifyRes.statusCode, 200, 'verifyOtpUnified returns HTTP 200');
  assert.strictEqual(mockVerifyRes.body?.success, true, 'verifyOtpUnified response.success is true');
  console.log('  ✓ Controller flow executed and verified successfully!\n');

  console.log('==================================================================');
  console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('==================================================================');

  process.exit(0);
};

runIntegrationTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
