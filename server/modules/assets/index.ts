// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';
// ensureImageAssetsDir: the paseo module stores the images the Paseo app sends inline (base64) here too.
export { ensureImageAssetsDir } from './services/image-assets.service.js';
