// RNNoise (xiph/rnnoise, built to WebAssembly from source) as an AudioWorklet.
// RNNoise works on 480-sample frames at 48 kHz; the audio graph hands us
// 128-sample blocks, so input is gathered into frames and the cleaned audio
// is played back with a fixed 448-sample delay (the worst gap between a
// block and the next finished frame), which never runs dry.
const FRAME = 480;
const PRIME = 448;
const RING = 4096;

class SolarRnnoise extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ready = false;
    this.alive = true;
    this.frame = new Float32Array(FRAME);
    this.frameLen = 0;
    this.ring = new Float32Array(RING);
    this.readAt = 0;
    this.writeAt = PRIME;
    WebAssembly.instantiate(options.processorOptions.wasm, {}).then(({ instance }) => {
      if (!this.alive) return;
      const e = instance.exports;
      e._initialize?.();
      this.e = e;
      this.state = e.rnnoise_create(0);
      this.inPtr = e.malloc(FRAME * 4);
      this.outPtr = e.malloc(FRAME * 4);
      this.ready = true;
      this.port.postMessage({ ready: true });
    }).catch((err) => this.port.postMessage({ error: String(err) }));
    this.port.onmessage = (ev) => {
      if (ev.data !== 'destroy') return;
      this.alive = false;
      if (this.ready) {
        this.ready = false;
        this.e.rnnoise_destroy(this.state);
        this.e.free(this.inPtr);
        this.e.free(this.outPtr);
      }
    };
  }

  runFrame() {
    const e = this.e;
    const heap = new Float32Array(e.memory.buffer);
    const inAt = this.inPtr >> 2;
    for (let i = 0; i < FRAME; i++) heap[inAt + i] = this.frame[i] * 32768;
    e.rnnoise_process_frame(this.state, this.outPtr, this.inPtr);
    const out = new Float32Array(e.memory.buffer, this.outPtr, FRAME);
    for (let i = 0; i < FRAME; i++) {
      this.ring[this.writeAt] = out[i] / 32768;
      this.writeAt = (this.writeAt + 1) % RING;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return this.alive;
    const input = inputs[0]?.[0];
    if (!this.ready) {
      if (input) out.set(input); else out.fill(0);
      return this.alive;
    }
    for (let i = 0; i < out.length; i++) {
      this.frame[this.frameLen++] = input ? input[i] : 0;
      if (this.frameLen === FRAME) { this.runFrame(); this.frameLen = 0; }
    }
    for (let i = 0; i < out.length; i++) {
      out[i] = this.ring[this.readAt];
      this.readAt = (this.readAt + 1) % RING;
    }
    return this.alive;
  }
}

registerProcessor('solar-rnnoise', SolarRnnoise);
