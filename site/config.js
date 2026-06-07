// Selects prod or preprod config based on the current hostname.
const CTC_CONFIG = (() => {
  const host = window.location.hostname;
  const isPreprod = host === 'preprod.coastaltravelcompany.com';
  const origin    = isPreprod ? 'https://preprod.coastaltravelcompany.com' : 'https://coastaltravelcompany.com';
  const worker    = isPreprod
    ? 'https://api.preprod.coastaltravelcompany.com'
    : 'https://api.coastaltravelcompany.com';
  return {
    workerUrl:    worker,
    mainSiteUrl:  origin + '/gallery/gallery.html',
    nasClientUrl: origin + '/gallery/client-gallery.html',
  };
})();
