const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const elements = {};
const document = {
  getElementById(id) {
    return elements[id] ||= {
      width: 520, height: 760, value: id === 'neckWidth' ? '28' : '500',
      getContext: () => new Proxy({}, {
        get: (_, key) => key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {},
      }),
      addEventListener(event, callback) { this[event] = callback; },
    };
  },
};
const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
new Function('document', 'performance', 'requestAnimationFrame', 'assert', source + `
  const a = new Particle(260, 600, 3);
  const b = new Particle(260, 600, 3);
  a.resting = b.resting = true;
  resolvePair(a, b);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 5.98,
    'Coincident sleeping particles must separate');

  for (const width of [12, 80, 28]) {
    neckWidthInput.value = String(width);
    neckWidthInput.input();
    assert.equal(NECK_HALF_WIDTH * 2, width);
    assert.equal(neckWidthValue.textContent, String(width));
    for (let frame = 0; frame < 120; frame++) step(1 / 60);
    assert.equal(particles.length, 500);
    let maxOverlap = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        maxOverlap = Math.max(maxOverlap,
          1 - Math.hypot(p.x - q.x, p.y - q.y) / (p.r + q.r));
      }
    }
    assert.ok(maxOverlap < .1, 'Particle overlap must stay below 10% of diameter');
    finishFlip();
    console.log('PASS neck width', width, 'overlap', (maxOverlap * 100).toFixed(2) + '%');
  }
`)(document, { now: () => 0 }, () => {}, assert);
