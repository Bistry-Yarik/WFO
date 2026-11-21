const SOUND_UPDATE_MS = 110;
const SOUND_EVENTS_PER_SAMPLE = 64;
const SOUND_NEAR_ZOOM = 120;

function soundStrength(amount, reference) {
    return Math.log2(1 + amount / reference);
}

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
        hum.frequency.value = 65;
        this.humFrequency = hum.frequency;
        hum.setPeriodicWave(context.createPeriodicWave(
            new Float32Array([0, 0, 0, 0, 0]),
            new Float32Array([0, 0.28, 0.75, 0.4, 0.16])
        ));
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
        this.cos = Math.cos(camera.angle ?? 0);
        this.sin = Math.sin(camera.angle ?? 0);
        const centerX = field.width / (2 * camera.zoom);
        const centerY = field.height / (2 * camera.zoom);
        this.x = camera.x + this.cos * centerX + this.sin * centerY;
        this.y = camera.y - this.sin * centerX + this.cos * centerY;
        this.zoomGain = Math.min(1, (camera.zoom / SOUND_NEAR_ZOOM) ** 0.4);
    }

    record(kind, index) {
        if (!this.width || this.eventCount >= SOUND_EVENTS_PER_SAMPLE || this.context.state !== 'running') return;
        this.eventCount++;
        const worldX = soundDistance(index % this.width + 0.5 - this.x, this.width);
        const worldY = soundDistance(Math.floor(index / this.width) + 0.5 - this.y, this.height);
        const dx = (this.cos * worldX - this.sin * worldY) / this.rangeX;
        const dy = (this.sin * worldX + this.cos * worldY) / this.rangeY;
        const gain = this.zoomGain / (1 + dx * dx + dy * dy);
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
        const rotated = this.sin !== 0;
        const horizontal = new Float64Array(this.width);
        const pans = new Float64Array(this.width);
        for (let x = 0; x < this.width; x++) {
            const distance = soundDistance(x + 0.5 - this.x, this.width);
            const dx = distance / this.rangeX;
            horizontal[x] = 1 / (1 + dx * dx);
            pans[x] = rotated ? distance : dx;
        }

        let audibleWeight = 0;
        let energy = 0;
        let energyPeak = 0;
        let maxEnergy = 0;
        let organic = 0;
        let radiation = 0;
        let energyPan = 0;
        let organicPan = 0;
        let radiationPan = 0;
        const { soil } = world.limits;
        for (let y = 0; y < this.height; y++) {
            const distance = soundDistance(y + 0.5 - this.y, this.height);
            const dy = distance / this.rangeY;
            const vertical = 1 / (1 + dy * dy);
            for (let x = 0; x < this.width; x++) {
                let pan = pans[x];
                let weight = horizontal[x] * vertical;
                if (rotated) {
                    const screenY = (this.sin * pan + this.cos * distance) / this.rangeY;
                    pan = (this.cos * pan - this.sin * distance) / this.rangeX;
                    weight = 1 / ((1 + pan * pan) * (1 + screenY * screenY));
                }
                pan = Math.max(-1, Math.min(1, pan));
                const index = y * this.width + x;
                audibleWeight += weight;
                const power = world.energy[index];
                if (power > maxEnergy) maxEnergy = power;
                const e = power > 0 ? soundStrength(power, soil) * (power / (power + 60)) * weight : 0;
                const o = world.organic[index] >= soil ? soundStrength(world.organic[index], soil) * weight : 0;
                const r = soundStrength(world.radiation[index], 1000) * weight;
                energy += e;
                if (e > energyPeak) energyPeak = e;
                organic += o;
                radiation += r;
                energyPan += e * pan;
                organicPan += o * pan;
                radiationPan += r * pan;
            }
        }

        const time = this.context.currentTime;
        const normalization = 6 * Math.max(1, audibleWeight / 32);
        const level = weight => weight / (weight + normalization) * this.zoomGain;
        const nearbyHum = 0.38 * (energyPeak / (energyPeak + 0.16)) ** 0.85 * this.zoomGain;
        const pitchStrength = soundStrength(maxEnergy, soil) * (maxEnergy / (maxEnergy + 60));
        this.humFrequency.setTargetAtTime(65 + 155 * pitchStrength / (pitchStrength + 0.5), time, 0.12);
        this.hum.gain.gain.setTargetAtTime(Math.max(level(energy), nearbyHum) * 0.52, time, 0.07);
        this.sizzle.gain.gain.setTargetAtTime(level(organic) * 0.8, time, 0.07);
        this.hum.pan?.setTargetAtTime(energy ? energyPan / energy : 0, time, 0.07);
        this.sizzle.pan?.setTargetAtTime(organic ? organicPan / organic : 0, time, 0.07);

        const radiationLevel = level(radiation);
        this.nextClick = Math.max(time, this.nextClick);
        while (radiationLevel > 0 && this.nextClick < time + SOUND_UPDATE_MS / 1000) {
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
