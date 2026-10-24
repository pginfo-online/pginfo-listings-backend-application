/**
 * Centralized Property Domain Enums
 */
const PropertyCategory = Object.freeze({
  PG: 'pg',
  RESIDENTIAL_RENTAL: 'residential_rental',
  COMMERCIAL: 'commercial',
});

const PropertyPurpose = Object.freeze({
  RENT: 'rent',
  SALE: 'sale',
});

const PropertyStatus = Object.freeze({
  DRAFT: 'draft',
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CORRECTION_REQUIRED: 'correction_required',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived',
});

const PGGender = Object.freeze({
  MALE: 'male',
  FEMALE: 'female',
  UNISEX: 'unisex',
  ANY: 'any',
});

const PGFoodOption = Object.freeze({
  INCLUDED: 'included',
  OPTIONAL: 'optional',
  NOT_AVAILABLE: 'not_available',
  NONE: 'none',
});

const PGShareType = Object.freeze({
  SINGLE: 'single',
  DOUBLE: 'double',
  TRIPLE: 'triple',
  FOUR: 'four',
  OTHER: 'other',
});

const FurnishingStatus = Object.freeze({
  UNFURNISHED: 'unfurnished',
  SEMI_FURNISHED: 'semi_furnished',
  FULLY_FURNISHED: 'fully_furnished',
});

const CommercialSubtype = Object.freeze({
  OFFICE_SPACE: 'office_space',
  CO_WORKING: 'co_working',
  RETAIL_SHOP: 'retail_shop',
  SHOWROOM: 'showroom',
  WAREHOUSE_GODOWN: 'warehouse_godown',
  INDUSTRIAL_BUILDING: 'industrial_building',
  COMMERCIAL_LAND: 'commercial_land',
  OTHER: 'other',
});

const ListedBy = Object.freeze({
  OWNER: 'owner',
  AGENT: 'agent',
  BUILDER: 'builder',
});

module.exports = {
  PropertyCategory,
  PropertyPurpose,
  PropertyStatus,
  PGGender,
  PGFoodOption,
  PGShareType,
  FurnishingStatus,
  CommercialSubtype,
  ListedBy,
};
