const Property = require('../../../models/Property.model');
const redisCache = require('../../../services/redisCache.service');

const CACHE_TTL_SECONDS = 300; // 5 minutes

class PropertyRepository {
  /**
   * Find property by ID with optional population and Redis caching
   */
  async findById(id, options = {}) {
    const cacheKey = `property:id:${id}`;
    if (options.useCache) {
      const cached = await redisCache.get(cacheKey).catch(() => null);
      if (cached) return cached;
    }

    let query = Property.findById(id);

    if (options.populateOwner) {
      query = query.populate('owner', 'name email phone avatar isPhoneVerified isEmailVerified');
    }
    if (options.populateLocation !== false) {
      query = query.populate('cityId', 'name slug state').populate('areaId', 'name slug');
    }
    if (options.lean) {
      query = query.lean();
    }

    const doc = await query.exec();

    if (doc && options.useCache) {
      await redisCache.set(cacheKey, doc, CACHE_TTL_SECONDS).catch(() => {});
    }

    return doc;
  }

  /**
   * Find property by unique SEO slug
   */
  async findBySlug(slug, options = {}) {
    const cacheKey = `property:slug:${slug}`;
    if (options.useCache) {
      const cached = await redisCache.get(cacheKey).catch(() => null);
      if (cached) return cached;
    }

    let query = Property.findOne({ slug });

    if (options.populateOwner) {
      query = query.populate('owner', 'name email phone avatar isPhoneVerified isEmailVerified');
    }
    if (options.populateLocation !== false) {
      query = query.populate('cityId', 'name slug state').populate('areaId', 'name slug');
    }
    if (options.lean) {
      query = query.lean();
    }

    const doc = await query.exec();

    if (doc && options.useCache) {
      await redisCache.set(cacheKey, doc, CACHE_TTL_SECONDS).catch(() => {});
    }

    return doc;
  }

  /**
   * Paginated find with count
   */
  async findPaginated(filter = {}, pagination = {}, sort = { createdAt: -1 }, options = {}) {
    const { skip = 0, limit = 20 } = pagination;

    let query = Property.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit);

    if (options.populateOwner) {
      query = query.populate('owner', 'name email phone avatar');
    }
    if (options.populateLocation !== false) {
      query = query.populate('cityId', 'name slug state').populate('areaId', 'name slug');
    }
    if (options.select) {
      query = query.select(options.select);
    }
    if (options.lean !== false) {
      query = query.lean();
    }

    const [data, total] = await Promise.all([
      query.exec(),
      Property.countDocuments(filter),
    ]);

    return { data, total };
  }

  /**
   * Create a new property document
   */
  async create(data) {
    const property = new Property(data);
    await property.save();
    this.invalidateCache(property._id, property.slug);
    return property;
  }

  /**
   * Atomically update a property by ID
   */
  async updateById(id, updateData, options = { new: true }) {
    const updated = await Property.findByIdAndUpdate(id, updateData, options).exec();
    if (updated) {
      this.invalidateCache(id, updated.slug);
    }
    return updated;
  }

  /**
   * Delete a property by ID
   */
  async deleteById(id) {
    const deleted = await Property.findByIdAndDelete(id).exec();
    if (deleted) {
      this.invalidateCache(id, deleted.slug);
    }
    return deleted;
  }

  /**
   * Count documents matching a filter
   */
  async count(filter = {}) {
    return Property.countDocuments(filter).exec();
  }

  /**
   * Increment view counter atomically (with cache invalidation debounce)
   */
  async incrementViews(id) {
    return Property.findByIdAndUpdate(id, { $inc: { views: 1 } }, { new: false }).exec();
  }

  /**
   * Invalidate Redis caches for a property
   */
  invalidateCache(id, slug) {
    if (id) redisCache.del(`property:id:${id}`).catch(() => {});
    if (slug) redisCache.del(`property:slug:${slug}`).catch(() => {});
    redisCache.delByPattern('search:properties:*').catch(() => {});
    redisCache.delByPattern('search:suggest:*').catch(() => {});
  }
}

module.exports = new PropertyRepository();
