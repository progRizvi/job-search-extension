// Service workers cannot play sound, so this hidden page does it: three rising tones.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'beep') return;
  const ctx = new AudioContext();
  [660, 880, 1100].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.25;
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.3);
    osc.stop(ctx.currentTime + i * 0.3 + 0.22);
  });
  setTimeout(() => ctx.close(), 1500);
});
