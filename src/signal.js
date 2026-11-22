// A small physical model of a cold-storage unit, shared by the simulator and the seed script.
// Temperature relaxes toward a target ("setpoint" normally, warmer during a door/power event).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Signal {
  /**
   * @param {object} dev      { minTemp, maxTemp }
   * @param {object} opts     { k: relaxation per step, rand: RNG, battery, drain: battery % lost per step }
   */
  constructor(dev, { k = 0.15, rand = Math.random, battery = 90, drain = 0.0004 } = {}) {
    this.min = dev.minTemp;
    this.max = dev.maxTemp;
    this.mid = (dev.minTemp + dev.maxTemp) / 2;
    this.span = dev.maxTemp - dev.minTemp;
    this.k = k;
    this.rand = rand;
    this.battery = battery;
    this.drain = drain;
    this.temp = this.mid;
    this.mode = null;
    this.left = 0;
  }

  // kind: 'door' (short, mild warm-up) | 'power' (compressor failure, long and severe)
  start(kind, steps) {
    this.mode = kind;
    this.left = steps ?? (kind === 'power' ? 20 : 8);
  }

  next() {
    let target = this.mid;
    let door = 0;
    if (this.left > 0) {
      if (this.mode === 'door') { target = this.max + this.span * 0.25; door = 1; }
      else { target = this.max + this.span * 1.6; }
      this.left--;
      if (this.left === 0) this.mode = null;
    }
    const noise = (this.rand() - 0.5) * this.span * 0.04;
    this.temp += (target - this.temp) * this.k + noise;
    this.battery = Math.max(0, this.battery - this.drain);
    const hum = 42 + this.rand() * 10 + (door ? 18 : 0) + (this.mode === 'power' ? 12 : 0);
    return { temp: this.temp, hum, battery: this.battery, door };
  }
}

module.exports = { Signal, mulberry32 };
