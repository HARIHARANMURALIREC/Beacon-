'use strict';
// Macs can't reliably report their chip to a web page, so Mac visitors choose from the list.
(function () {
  var primary = document.getElementById('primary-download');
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/mac/i.test(platform)) {
    primary.textContent = 'Download for Mac';
    primary.href = '#download';
  } else if (/win/i.test(platform)) {
    primary.textContent = 'Download for Windows';
  } else {
    primary.href = '#download';
  }
})();
