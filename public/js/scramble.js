// Scramble-reveal animation engine with WebAudio sound
export class ScrambleReveal {
  constructor() {
    this.chars = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯABCDEF@HIJ_LM%OPQR^WX#YZ0123456789абвгдежзийклмнопрстуфхцчшщэюя+-*#@%^&";
    this.activeId = 0;
    this.audioContext = null;
    this.oscillator = null;
    this.gainNode = null;
  }

  randomChar() {
    return this.chars[Math.floor(Math.random() * this.chars.length)];
  }

  /**
   * Следующий кадр анимации. В скрытой вкладке requestAnimationFrame не тикает,
   * поэтому дублируем таймером: кто сработает первым, тот и ведёт кадр.
   * Без этого reveal() в фоне зависает навсегда и прескрипт не доходит.
   */
  scheduleFrame(loop) {
    let fired = false;
    const once = () => {
      if (fired) return;
      fired = true;
      loop(performance.now());
    };
    requestAnimationFrame(once);
    setTimeout(once, 60);
  }

  initAudio() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  startSound() {
    this.initAudio();

    if (this.oscillator) {
      this.oscillator.stop();
    }

    this.oscillator = this.audioContext.createOscillator();
    this.gainNode = this.audioContext.createGain();

    // Glitchy digital sound
    this.oscillator.type = 'square';
    this.oscillator.frequency.setValueAtTime(200, this.audioContext.currentTime);

    // Rapid frequency modulation
    const lfo = this.audioContext.createOscillator();
    const lfoGain = this.audioContext.createGain();
    lfoGain.gain.value = 100;
    lfo.frequency.value = 20;
    lfo.connect(lfoGain);
    lfoGain.connect(this.oscillator.frequency);
    lfo.start();

    this.gainNode.gain.setValueAtTime(0.05, this.audioContext.currentTime);

    this.oscillator.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
    this.oscillator.start();
  }

  stopSound() {
    if (this.oscillator) {
      this.gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
      this.oscillator.stop(this.audioContext.currentTime + 0.1);
      this.oscillator = null;
    }
  }

  async reveal(text, options = {}) {
    const {
      scrambleTime = 0.5,
      revealTime = 1.5,
      scrambleSpeed = 50,
      onUpdate = () => {},
      onComplete = () => {}
    } = options;

    const runId = ++this.activeId;
    const start = performance.now();
    let lastTick = 0;

    this.startSound();

    return new Promise(resolve => {
      const loop = (now) => {
        if (runId !== this.activeId) {
          this.stopSound();
          resolve();
          return;
        }

        if (now - lastTick < scrambleSpeed) {
          this.scheduleFrame(loop);
          return;
        }
        lastTick = now;

        const elapsed = (now - start) / 1000;

        // Scramble phase
        if (elapsed < scrambleTime) {
          let out = "";
          for (let i = 0; i < text.length; i++) {
            out += text[i] === ' ' || text[i] === '\n' ? text[i] : this.randomChar();
          }
          onUpdate(out);
          this.scheduleFrame(loop);
          return;
        }

        // Reveal phase
        const progress = Math.min((elapsed - scrambleTime) / revealTime, 1);
        const revealCount = Math.floor(progress * text.length);

        let out = "";
        for (let i = 0; i < text.length; i++) {
          if (text[i] === ' ' || text[i] === '\n') {
            out += text[i];
          } else {
            out += i < revealCount ? text[i] : this.randomChar();
          }
        }

        onUpdate(out);

        if (progress < 1) {
          this.scheduleFrame(loop);
        } else {
          this.stopSound();
          onUpdate(text);
          onComplete();
          resolve();
        }
      };

      this.scheduleFrame(loop);
    });
  }

  cancel() {
    this.activeId++;
    this.stopSound();
  }
}
