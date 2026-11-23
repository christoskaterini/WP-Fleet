import path from 'node:path';

export const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$|^localhost$/i;
export const HESTIA_USER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const ZIP_NAME_RE = /^[a-zA-Z0-9._-]+\.zip$/;

export function assertSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    const err = new Error(`Invalid slug: ${String(slug)}`);
    err.statusCode = 400;
    throw err;
  }
  return slug;
}

export function assertDomainFormat(domain) {
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) {
    const err = new Error(`Invalid domain: ${String(domain)}`);
    err.statusCode = 400;
    throw err;
  }
  return domain.toLowerCase();
}

export function assertHestiaUser(user) {
  if (typeof user !== 'string' || user === 'root' || !HESTIA_USER_RE.test(user)) {
    const err = new Error(`Invalid user: ${String(user)}`);
    err.statusCode = 400;
    throw err;
  }
  return user;
}

export function assertAssetType(type) {
  if (type !== 'plugin' && type !== 'theme') {
    const err = new Error(`Invalid asset type: ${String(type)}`);
    err.statusCode = 400;
    throw err;
  }
  return type;
}

export function assertZipFilename(filename) {
  if (
    typeof filename !== 'string' ||
    filename.includes('..') ||
    path.basename(filename) !== filename ||
    !ZIP_NAME_RE.test(filename)
  ) {
    const err = new Error(`Invalid ZIP filename: ${String(filename)}`);
    err.statusCode = 400;
    throw err;
  }
  return filename;
}
