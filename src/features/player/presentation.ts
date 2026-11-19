/** Short, original interface cues synthesized locally. */
export type PlayerCue = 'choices-open' | 'choice' | 'save' | 'load' | 'ending';

const cueNotes: Record<Exclude<PlayerCue, 'choices-open'>, number[]> = {
  choice: [420],
  save: [523.25, 659.25],
  load: [659.25, 523.25],
  ending: [261.63, 329.63, 392],
};

function playChoiceBeep(context: AudioContext, volume: number) {
  const duration = 0.12;
  const buffer = context.createBuffer(
    1,
    Math.round(context.sampleRate * duration),
    context.sampleRate,
  );
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    const time = i / context.sampleRate;
    const envelope = Math.min(1, time / 0.009, (duration - time) / 0.045);
    samples[i] = volume * 0.09 * envelope * Math.sin(2 * Math.PI * 510 * time);
  }

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.onended = () => source.disconnect();
  source.start();
}

export class PlayerAudio {
  private context?: AudioContext;
  play(kind: PlayerCue, volume: number) {
    if (!volume) return;
    try {
      // Browsers can keep audio suspended until the player makes a gesture.
      if (!this.context) {
        this.context = new AudioContext();
      }
      const context = this.context;
      const schedule = () => {
        if (context.state !== 'running') return;
        if (kind === 'choices-open') {
          playChoiceBeep(context, volume);
          return;
        }
        cueNotes[kind].forEach((frequency, i) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const at = context.currentTime + i * 0.065;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, at);
          const duration = kind === 'choice' ? 0.07 : 0.18;
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(volume * 0.075, at + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + duration + 0.01);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
          };
        });
      };
      if (context.state === 'running') schedule();
      else
        void context
          .resume()
          .then(schedule)
          .catch(() => {});
    } catch {
      /* Playback remains available on devices without Web Audio. */
    }
  }
  close() {
    void this.context?.close().catch(() => {});
  }
}
