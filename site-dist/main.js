'use strict';
// Points the main button straight at the installer for this computer.
(function () {
  var primary = document.getElementById('primary-download');
  var note = document.getElementById('primary-note');
  var uaData = navigator.userAgentData;
  var platform = (uaData && uaData.platform) || navigator.platform || '';

  function fileUrl(name) {
    return document.querySelector('[data-file="' + name + '"]').href;
  }

  function useMacFile(chip) {
    var other = chip === 'arm' ? 'Intel' : 'Apple silicon';
    primary.textContent = 'Download for Mac (' + (chip === 'arm' ? 'Apple silicon' : 'Intel') + ')';
    primary.href = fileUrl(chip === 'arm' ? 'mac-arm' : 'mac-intel');
    note.textContent = 'Have a Mac with ' + other + '? Use the other download under All downloads.';
  }

  function graphicsChip() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
      if (/Apple M\d/i.test(renderer)) return 'arm';
      if (/Intel|AMD|Radeon/i.test(renderer)) return 'intel';
    } catch (err) {
      // Some browsers block this. The default below still applies.
    }
    return null;
  }

  if (/mac/i.test(platform)) {
    // Browsers don't always reveal the chip. Most current Macs use Apple silicon,
    // and the note under the button covers a wrong guess.
    useMacFile(graphicsChip() || 'arm');
    if (uaData && uaData.getHighEntropyValues) {
      uaData.getHighEntropyValues(['architecture']).then(function (values) {
        if (values.architecture === 'arm') useMacFile('arm');
        if (values.architecture === 'x86') useMacFile('intel');
      }).catch(function () {});
    }
  } else if (/win/i.test(platform)) {
    primary.textContent = 'Download for Windows';
    primary.href = fileUrl('windows');
  } else {
    // Beacon has no build for phones or Linux, so show the options instead.
    primary.textContent = 'See downloads';
    primary.href = '#download';
  }
})();
