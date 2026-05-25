// Selects prod or preprod config based on the current hostname.
const CTC_CONFIG = (() => {
  const host = window.location.hostname;
  const isPreprod = host === 'preprod.coastaltravelcompany.com';
  const origin    = isPreprod ? 'https://preprod.coastaltravelcompany.com' : 'https://coastaltravelcompany.com';
  const worker    = isPreprod
    ? 'https://coastal-gallery-proxy-preprod.thecoastaltravelcompany.workers.dev'
    : 'https://coastal-gallery-proxy.thecoastaltravelcompany.workers.dev';
  return {
    workerUrl:    worker,
    mainSiteUrl:  origin + '/gallery/gallery.html',
    nasClientUrl: origin + '/gallery/client-gallery.html',
  };
})();
