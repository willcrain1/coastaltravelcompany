export const NAS_SHARE_API  = 'https://nas.coastaltravelcompany.com/mo/sharing/webapi/entry.cgi';
export const NAS_SHARE_PAGE = 'https://nas.coastaltravelcompany.com/mo/sharing/';
export const ALLOWED_ORIGIN = 'https://coastaltravelcompany.com';

export const RATE_LIMIT         = 300;
export const CONTACT_RATE_LIMIT = 5;
export const CONTACT_TO         = 'thecoastaltravelcompany@gmail.com';
export const WM_TEXT            = '© Coastal Travel Company';
export const JWT_EXPIRY_SECS    = 7 * 24 * 3600;

export const ALLOWED_APIS = new Set([
  'SYNO.Foto.Browse.Item',
  'SYNO.Foto.Thumbnail',
  'SYNO.Foto.Download',
  'SYNO.Foto.Streaming',
]);

export const CORS = {
  'Access-Control-Allow-Origin':   ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods':  'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':  'Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'Content-Disposition',
  'Access-Control-Max-Age':        '86400',
};
