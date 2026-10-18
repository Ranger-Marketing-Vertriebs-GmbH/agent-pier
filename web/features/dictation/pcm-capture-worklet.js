/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// The dictation's audio worklet: the microphone at the context's own rate becomes
// 16 kHz mono 16-bit PCM in 100 ms frames, the format Deepgram streams without a
// container. Chrome, Safari and Firefox record the same way, unlike MediaRecorder.
// Kept free of imports: Vite serves this file as it is (useDictation.js).
export const targetRate = 16000;
const frameSamples = targetRate / 10;

/** Averages the input down to 16 kHz and collects 100 ms frames of Int16 PCM. */
export class PcmEncoder {
  constructor(inputRate) {
    this.step = inputRate / targetRate;
    this.position = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(frameSamples);
    this.length = 0;
    this.peak = 0;
  }
  /** Returns the completed frames (each a transferable ArrayBuffer) for `input`. */
  push(input) {
    const frames = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.position += 1;
      if (this.position < this.step) continue;
      this.position -= this.step;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.peak = Math.max(this.peak, Math.abs(value));
      this.frame[this.length++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.length === frameSamples) {
        frames.push({ buffer: this.frame.buffer, level: this.peak });
        this.frame = new Int16Array(frameSamples);
        this.length = 0;
        this.peak = 0;
      }
    }
    return frames;
  }
}

if (typeof registerProcessor === "function")
  registerProcessor(
    "agentpier-pcm",
    class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.encoder = new PcmEncoder(sampleRate);
      }
      process(inputs) {
        const channel = inputs[0]?.[0];
        if (channel)
          for (const frame of this.encoder.push(channel))
            this.port.postMessage(frame, [frame.buffer]);
        return true;
      }
    },
  );
