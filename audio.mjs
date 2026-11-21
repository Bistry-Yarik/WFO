const SOUND_UPDATE_MS = 110;
const SOUND_EVENTS_PER_SAMPLE = 64;

function soundDistance(delta, size) {
    return delta - Math.round(delta / size) * size;
}

export class WorldAudio {
    constructor(AudioContext) {
        const context = new AudioContext();
        this.context = context;
        this.master = context.createGain();
        this.master.gain.value = 0.4;
        const limiter = context.createDynamicsCompressor();
        this.master.connect(limiter);
        limiter.connect(context.destination);
        this.randomState = Date.now() >>> 0;
        this.noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
        const samples = this.noise.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = this.random() * 2 - 1;

        const hum = context.createOscillator();
        hum.type = 'triangle';
        hum.frequency.value = 60;
        this.hum = this.track(hum);
        hum.start();

        const sizzle = context.createBufferSource();
        sizzle.buffer = this.noise;
        sizzle.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 2500;
        sizzle.connect(filter);
        this.sizzle = this.track(filter);
        sizzle.start();

        this.events = {};
        this.eventCount = 0;
        this.lastUpdate = -Infinity;
        this.nextClick = 0;
    }

    random() {
        this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
        return this.randomState / 4294967296;
    }

    track(source) {
        const gain = this.context.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        const pan = this.connectPan(gain)?.pan;
        return { gain, pan };
    }

    connectPan(node, panValue = 0) {
        if (!this.context.createStereoPanner) {
            node.connect(this.master);
            return null;
        }
        const pan = this.context.createStereoPanner();
        pan.pan.value = panValue;
        node.connect(pan);
        pan.connect(this.master);
        return pan;
    }

    setListener(world, camera, field) {
        this.width = world.width;
        this.height = world.height;
        this.rangeX = Math.max(4, field.width / (2 * camera.zoom));
        this.rangeY = Math.max(4, field.height / (2 * camera.zoom));
        this.x = camera.x + field.width / (2 * camera.zoom);
        this.y = camera.y + field.height / (2 * camera.zoom);
        this.zoomGain = Math.min(1, Math.sqrt(camera.zoom / 10));
    }

    record(kind, index) {
        if (!this.width || this.eventCount >= SOUND_EVENTS_PER_SAMPLE || this.context.state !== 'running') return;
        this.eventCount++;
        const dx = soundDistance(index % this.width + 0.5 - this.x, this.width) / this.rangeX;
        const dy = soundDistance(Math.floor(index / this.width) + 0.5 - this.y, this.height) / this.rangeY;
        const gain = Math.max(0, 1 - dx * dx - dy * dy) * this.zoomGain;
        if (gain > (this.events[kind]?.gain ?? 0)) {
            this.events[kind] = { gain, pan: Math.max(-1, Math.min(1, dx)) };
        }
    }

    play(kind, volume, pan, start = this.context.currentTime) {
        const { context } = this;
        const source = context.createBufferSource();
        source.buffer = this.noise;
        const filter = context.createBiquadFilter();
        filter.type = kind === 'death' ? 'highpass' : 'bandpass';
        filter.frequency.value = kind === 'geiger' ? 3600 : kind === 'birth' ? 1800 : 950;
        filter.Q.value = kind === 'geiger' ? 2.6 : 0.6;
        const duration = kind === 'birth' ? 0.17 : kind === 'death' ? 0.085 : 0.022;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + (kind === 'birth' ? 0.035 : 0.002));
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        source.connect(filter);
        filter.connect(envelope);
        const panner = this.connectPan(envelope, pan);
        source.onended = () => {
            source.disconnect();
            filter.disconnect();
            envelope.disconnect();
            panner?.disconnect();
        };
        source.start(start, this.random() * 0.7, duration);
    }

    update(now, world, camera, field) {
        if (this.context.state !== 'running' || now - this.lastUpdate < SOUND_UPDATE_MS) return;
        this.lastUpdate = now;
        this.setListener(world, camera, field);
        const horizontal = new Float64Array(this.width);
        const pans = new Float64Array(this.width);
        for (let x = 0; x < this.width; x++) {
            const dx = soundDistance(x + 0.5 - this.x, this.width) / this.rangeX;
            horizontal[x] = Math.max(0, 1 - dx * dx);
            pans[x] = dx;
        }

        let energy = 0;
        let organic = 0;
        let radiation = 0;
        let energyPan = 0;
        let organicPan = 0;
        let radiationPan = 0;
        const { soil } = world.limits;
        for (let y = 0; y < this.height; y++) {
            const dy = soundDistance(y + 0.5 - this.y, this.height) / this.rangeY;
            const vertical = Math.max(0, 1 - dy * dy);
            if (vertical === 0) continue;
            for (let x = 0; x < this.width; x++) {
                const weight = horizontal[x] * vertical;
                if (weight === 0) continue;
                const index = y * this.width + x;
                const e = world.energy[index] >= soil ? Math.min(world.energy[index] / soil - 0.85, 1) * weight : 0;
                const o = world.organic[index] >= soil ? Math.min(world.organic[index] / soil - 0.85, 1) * weight : 0;
                const r = Math.min(world.radiation[index] / 1000, 1) * weight;
                energy += e;
                organic += o;
                radiation += r;
                energyPan += e * pans[x];
                organicPan += o * pans[x];
                radiationPan += r * pans[x];
            }
        }

        const time = this.context.currentTime;
        const level = weight => (1 - Math.exp(-weight / 6)) * this.zoomGain;
        this.hum.gain.gain.setTargetAtTime(level(energy) * 0.45, time, 0.07);
        this.sizzle.gain.gain.setTargetAtTime(level(organic) * 0.8, time, 0.07);
        this.hum.pan?.setTargetAtTime(energy ? energyPan / energy : 0, time, 0.07);
        this.sizzle.pan?.setTargetAtTime(organic ? organicPan / organic : 0, time, 0.07);

        const radiationLevel = level(radiation);
        this.nextClick = Math.max(time, this.nextClick);
        while (radiationLevel > 0.002 && this.nextClick < time + SOUND_UPDATE_MS / 1000) {
            this.play('geiger', radiationLevel * 0.6, radiationPan / radiation, this.nextClick);
            this.nextClick += (0.65 + this.random() * 0.7) / (2 + 26 * radiationLevel);
        }
        for (const [kind, event] of Object.entries(this.events)) {
            this.play(kind, event.gain * (kind === 'death' ? 0.8 : 0.45), event.pan);
        }
        this.events = {};
        this.eventCount = 0;
    }
}
