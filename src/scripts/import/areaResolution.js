const slugUtil = require('../../common/utils/slug.util');

function normalizeAreaName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function getLocalityName(locality, area, cityName) {
  const candidate = typeof locality === 'string' && locality.trim()
    ? locality
    : typeof area === 'string'
      ? area
      : '';
  const normalizedCandidate = candidate.trim().replace(/\s+/g, ' ');
  return normalizedCandidate && slugUtil.slugify(normalizedCandidate)
    ? normalizedCandidate
    : cityName;
}

function areaNameKey(name) {
  const normalizedName = normalizeAreaName(name);
  return normalizedName ? `name:${normalizedName}` : '';
}

function areaSlugKey(name) {
  const slug = slugUtil.slugify(name);
  return slug ? `slug:${slug}` : '';
}

function getAreaFromMap(areaMap, name) {
  return areaMap.get(areaNameKey(name)) || areaMap.get(areaSlugKey(name));
}

function addAreaToMap(areaMap, area, aliasName = area.name) {
  const nameKey = areaNameKey(aliasName);
  const slugKey = areaSlugKey(aliasName);
  if (nameKey) areaMap.set(nameKey, area);
  if (slugKey) areaMap.set(slugKey, area);
  if (typeof area.slug === 'string' && area.slug.trim()) {
    areaMap.set(`slug:${area.slug.trim().toLowerCase()}`, area);
  }
}

function resolveAreaCandidates(existingAreas, localityNames, createArea) {
  const areaMap = new Map();
  existingAreas.forEach(area => addAreaToMap(areaMap, area));

  const areasToCreate = [];
  localityNames.forEach(localityName => {
    const existingArea = getAreaFromMap(areaMap, localityName);
    if (existingArea) {
      addAreaToMap(areaMap, existingArea, localityName);
      return;
    }

    const area = createArea(localityName);
    areasToCreate.push(area);
    addAreaToMap(areaMap, area, localityName);
  });

  return { areaMap, areasToCreate };
}

module.exports = {
  areaNameKey,
  areaSlugKey,
  getLocalityName,
  getAreaFromMap,
  normalizeAreaName,
  resolveAreaCandidates,
};
