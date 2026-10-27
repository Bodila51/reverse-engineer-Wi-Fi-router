// Injected into every frame before any page script runs. It does not change what the page sees;
// it only reports which script called a fingerprinting API, so the analyzer can apply the
// Englehardt & Narayanan 2016 criteria ("Online Tracking: A 1-million-site Measurement and Analysis").
(() => {
  if (window.__xrayHooked) return;
  window.__xrayHooked = true;
  const send = (api, detail) => {
    try {
      const stack = new Error().stack || '';
      const urls = stack.match(/(https?:\/\/[^\s)]+?)(?::\d+){1,2}/g) || [];
      const script = urls.map((u) => u.replace(/(:\d+){1,2}$/, '')).find((u) => !u.includes('__xray')) || location.href;
      const key = api + '|' + script + '|' + (detail && detail.key ? detail.key : '');
      const seen = (window.__xraySeen = window.__xraySeen || {});
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] > 1) return;
      if (typeof window.__xrayFp === 'function') window.__xrayFp({api, script, frame: location.href, detail: detail || null, t: Date.now()});
    } catch (e) {}
  };
  const wrap = (proto, name, fn) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (...args) {
        try {
          fn.call(this, args);
        } catch (e) {}
        return orig.apply(this, args);
      },
    });
  };

  // Canvas: remember what was drawn on each canvas, then judge it when the image is read.
  const st = new WeakMap();
  const state = (canvas) => {
    if (!st.has(canvas)) st.set(canvas, {colors: new Set(), chars: new Set(), saveRestore: false, listener: false});
    return st.get(canvas);
  };
  const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (C2D) {
    const textHook = function (args) {
      const s = state(this.canvas);
      for (const ch of String(args[0] || '')) s.chars.add(ch);
      s.colors.add(String(this.fillStyle) + '|' + String(this.strokeStyle));
    };
    wrap(C2D, 'fillText', textHook);
    wrap(C2D, 'strokeText', textHook);
    wrap(C2D, 'save', function () {
      state(this.canvas).saveRestore = true;
    });
    wrap(C2D, 'restore', function () {
      state(this.canvas).saveRestore = true;
    });
    wrap(C2D, 'measureText', function () {
      send('canvas.measureText', {key: 'm'});
    });
    wrap(C2D, 'getImageData', function (args) {
      const s = state(this.canvas);
      send('canvas.read', {
        key: 'gid',
        method: 'getImageData',
        width: this.canvas.width,
        height: this.canvas.height,
        readW: args[2],
        readH: args[3],
        colors: s.colors.size,
        chars: s.chars.size,
        saveRestore: s.saveRestore,
        listener: s.listener,
      });
    });
  }
  const HC = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  if (HC) {
    const readHook = (method) =>
      function () {
        const s = state(this);
        send('canvas.read', {
          key: method,
          method,
          width: this.width,
          height: this.height,
          readW: this.width,
          readH: this.height,
          colors: s.colors.size,
          chars: s.chars.size,
          saveRestore: s.saveRestore,
          listener: s.listener,
        });
      };
    wrap(HC, 'toDataURL', readHook('toDataURL'));
    wrap(HC, 'toBlob', readHook('toBlob'));
    wrap(HC, 'addEventListener', function () {
      state(this).listener = true;
    });
  }

  // WebGL: the unmasked GPU vendor and renderer (37445, 37446).
  for (const G of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!G) continue;
    wrap(G.prototype, 'getParameter', function (args) {
      if (args[0] === 37445 || args[0] === 37446) send('webgl.unmasked', {key: String(args[0]), param: args[0] === 37445 ? 'UNMASKED_VENDOR' : 'UNMASKED_RENDERER'});
    });
  }

  // Audio: an OfflineAudioContext with an oscillator and a compressor is the classic audio fingerprint.
  for (const name of ['AudioContext', 'OfflineAudioContext', 'webkitOfflineAudioContext']) {
    const A = window[name];
    if (!A) continue;
    const proto = A.prototype;
    wrap(proto, 'createOscillator', function () {
      this.__xo = true;
    });
    wrap(proto, 'createDynamicsCompressor', function () {
      this.__xc = true;
    });
    wrap(proto, 'startRendering', function () {
      send('audio.render', {key: name, oscillator: !!this.__xo, compressor: !!this.__xc});
    });
    wrap(proto, 'createAnalyser', function () {
      send('audio.analyser', {key: name});
    });
  }

  if (navigator.getBattery) wrap(Navigator.prototype, 'getBattery', () => send('battery', {key: 'b'}));
  if (window.RTCPeerConnection) {
    const R = window.RTCPeerConnection;
    wrap(R.prototype, 'createDataChannel', () => send('webrtc', {key: 'dc'}));
    wrap(R.prototype, 'createOffer', () => send('webrtc', {key: 'offer'}));
  }
  if (document.fonts && document.fonts.check) {
    let n = 0;
    wrap(Object.getPrototypeOf(document.fonts), 'check', () => {
      n++;
      if (n === 20) send('fonts.probe', {key: 'f', checks: n});
    });
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
    if (desc && desc.get) {
      Object.defineProperty(Navigator.prototype, 'plugins', {
        configurable: true,
        get() {
          send('plugins', {key: 'p'});
          return desc.get.call(this);
        },
      });
    }
  } catch (e) {}
})();
