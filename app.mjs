import { Simulation, WIDTH, HEIGHT, STEP, SOIL_LIMIT, CHANNEL_FLOW_LIMIT, ENERGY_RESOURCE, ORGANIC_RESOURCE } from './simulation.mjs';

const field = document.querySelector('#field');
const context = field.getContext('2d');
const scale = field.width / WIDTH;
const terrain = document.createElement('canvas');
terrain.width = WIDTH;
terrain.height = HEIGHT;
const terrainContext = terrain.getContext('2d');
const terrainPixels = terrainContext.createImageData(WIDTH, HEIGHT);
context.imageSmoothingEnabled = false;
const pause = document.querySelector('#pause');
const speed = document.querySelector('#speed');
const zoom = document.querySelector('#zoom');
const viewport = document.querySelector('.viewport');
const zoomOut = document.querySelector('#zoom-out');
const zoomIn = document.querySelector('#zoom-in');
const touch = matchMedia('(hover: none)').matches;
const inspectHint = touch ? 'Коснитесь клетки, чтобы увидеть ресурсы' : 'Наведите на клетку, чтобы увидеть ресурсы';
const clock = document.querySelector('#clock');
const phase = document.querySelector('#phase');
const stats = document.querySelector('#stats');
const inspect = document.querySelector('#inspect');
const FRAME_SIMULATION_BUDGET = 8;
const MAX_BACKLOG_SECONDS = 0.1;
const DEATH_EFFECT_MS = 650;
const MAX_DEATH_EFFECTS = 160;
const names = {
    seed: 'Семечко', channel: 'Канал', chlorophyll: 'Хлорофилл',
    organic: 'Сборщик органики', energy: 'Сборщик энергии', converter: 'Преобразователь', teeth: 'Зубы'
};

const deathEffects = new Map();
let simulation = new Simulation(Math.random, recordDeath);
let paused = false;
let hovered = -1;
let press = null;
let lastTap = null;
let planted = -1;
let plantedUntil = 0;
let elapsed = 0;
let previous = performance.now();

function drawCell(cell) {
    const x = (cell.index % WIDTH + 0.5) * scale;
    const y = (Math.floor(cell.index / WIDTH) + 0.5) * scale;
    const color = `hsl(${cell.colony.hue} 80% 70%)`;
    context.fillStyle = color;
    if (cell.type === 'channel') {
        context.strokeStyle = color;
        context.lineWidth = 1.4 + Math.min(cell.flow / CHANNEL_FLOW_LIMIT, 1) * 6.6;
        context.lineCap = 'round';
        context.beginPath();
        for (const index of simulation.neighbors(cell.index)) {
            const neighbor = simulation.cells.get(index);
            if (!neighbor || neighbor.colony.family !== cell.colony.family) continue;
            context.moveTo(x, y);
            context.lineTo((index % WIDTH + 0.5) * scale, (Math.floor(index / WIDTH) + 0.5) * scale);
        }
        context.stroke();
        context.beginPath();
        context.arc(x, y, Math.max(1.5, context.lineWidth / 2), 0, Math.PI * 2);
        context.fill();
    } else if (cell.type === 'seed') {
        context.beginPath();
        context.arc(x, y, 3.7, 0, Math.PI * 2);
        context.fill();
    } else if (cell.type === 'chlorophyll') {
        context.fillStyle = '#65e592';
        context.beginPath();
        context.moveTo(x, y - 4.3);
        context.lineTo(x + 4.3, y);
        context.lineTo(x, y + 4.3);
        context.lineTo(x - 4.3, y);
        context.fill();
    } else if (cell.type === 'converter' || cell.type === 'teeth') {
        const sides = cell.type === 'teeth' ? 3 : 5;
        context.fillStyle = cell.type === 'teeth' ? '#a52b3a' : '#c58aff';
        context.beginPath();
        for (let point = 0; point < sides; point++) {
            const angle = -Math.PI / 2 + point * 2 * Math.PI / sides;
            const px = x + Math.cos(angle) * 4.3;
            const py = y + Math.sin(angle) * 4.3;
            if (point === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
        }
        context.closePath();
        context.fill();
    } else {
        context.fillStyle = cell.type === 'organic' ? '#f66b77' : '#69b3ff';
        context.fillRect(x - 3.6, y - 3.6, 7.2, 7.2);
    }
}

function recordDeath(index, cause, resources) {
    if (deathEffects.size >= MAX_DEATH_EFFECTS || deathEffects.has(index)) return;
    deathEffects.set(index, { cause, resources, start: performance.now() });
}

function drawDeathEffects(now) {
    if (deathEffects.size === 0) return;
    context.save();
    context.lineWidth = 2;
    for (const [index, effect] of deathEffects) {
        const progress = (now - effect.start) / DEATH_EFFECT_MS;
        if (progress >= 1) {
            deathEffects.delete(index);
            continue;
        }

        const x = (index % WIDTH + 0.5) * scale;
        const y = (Math.floor(index / WIDTH) + 0.5) * scale;
        const expansion = effect.cause === 'excess' ? progress : 1 - progress;
        const radius = 2 + 16 * expansion;
        const both = effect.resources === (ENERGY_RESOURCE | ORGANIC_RESOURCE);
        context.globalAlpha = 1 - progress;
        if (effect.resources & ENERGY_RESOURCE) {
            context.strokeStyle = '#69b3ff';
            context.beginPath();
            context.arc(x, y, radius, 0, both ? Math.PI : 2 * Math.PI);
            context.stroke();
        }
        if (effect.resources & ORGANIC_RESOURCE) {
            context.strokeStyle = '#ff7885';
            context.beginPath();
            context.arc(x, y, radius, both ? Math.PI : 0, 2 * Math.PI);
            context.stroke();
        }
    }
    context.restore();
}

function draw() {
    const pixels = terrainPixels.data;
    const { energy, organic, radiation, daylight } = simulation;
    for (let index = 0; index < energy.length; index++) {
        const blue = Math.min(energy[index] / SOIL_LIMIT, 1);
        const red = Math.min(organic[index] / SOIL_LIMIT, 1);
        const green = Math.min(radiation[index] / SOIL_LIMIT, 1);
        const checker = (index % WIDTH + Math.floor(index / WIDTH)) % 2 === 0 ? 4 : 0;
        const offset = index * 4;
        const pale = Math.max(energy[index], organic[index], radiation[index]) >= SOIL_LIMIT ? 0.46 : 0;
        pixels[offset] = (16 + checker + 166 * red + 24 * green + 20 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 1] = ((daylight ? 29 : 19) + checker + 20 * red + 155 * green + 40 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 2] = ((daylight ? 24 : 32) + checker + 36 * red + 30 * green + 175 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 3] = 255;
    }
    terrainContext.putImageData(terrainPixels, 0, 0);
    context.drawImage(terrain, 0, 0, field.width, field.height);
    for (const cell of simulation.cells.values()) {
        if (cell.type === 'channel') drawCell(cell);
    }
    for (const cell of simulation.cells.values()) {
        if (cell.type !== 'channel') drawCell(cell);
    }
    const now = performance.now();
    drawDeathEffects(now);
    if (planted >= 0 && now < plantedUntil) {
        const x = (planted % WIDTH + 0.5) * scale;
        const y = (Math.floor(planted / WIDTH) + 0.5) * scale;
        context.strokeStyle = '#fff';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(x, y, 9, 0, Math.PI * 2);
        context.stroke();
    }
}

const statRows = [
    ['Колонии', () => simulation.colonies.size],
    ['Живые клетки', () => simulation.cells.size],
    ['Семечки за игру', () => simulation.totalSeeds],
    ['Мутации', () => simulation.mutations],
    ['Перегрузки', () => simulation.overloads]
].map(([title, value]) => {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const output = document.createElement('dd');
    label.textContent = title;
    row.append(label, output);
    stats.append(row);
    return { output, value };
});

function updateReadout() {
    phase.textContent = simulation.daylight ? '☀ День' : '☾ Ночь';
    const seconds = Math.floor(simulation.time);
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    for (const { output, value } of statRows) output.textContent = value();

    if (hovered < 0) {
        inspect.textContent = inspectHint;
        return;
    }
    const cell = simulation.cells.get(hovered);
    const soil = `Почва ⚡ ${Math.floor(simulation.energy[hovered])} / орг. ${Math.floor(simulation.organic[hovered])} / рад. ${Math.floor(simulation.radiation[hovered])}`;
    const needs = cell?.colony.seedNeeds;
    const requirements = cell?.type === 'channel'
        ? ` · Пороги семени (энергия/органика): рядом ${needs.energy}/${needs.organic}, бросок ${needs.throwEnergy}/${needs.organic}`
        : '';
    inspect.textContent = cell
        ? `${names[cell.type]} · ⚡ ${Math.floor(cell.energy)} / орг. ${Math.floor(cell.organic)}${requirements} · ${soil}`
        : soil;
}

function indexAt(event) {
    const rect = field.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * WIDTH / rect.width);
    const y = Math.floor((event.clientY - rect.top) * HEIGHT / rect.height);
    return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT ? y * WIDTH + x : -1;
}

function plant(index) {
    if (index < 0) return;
    hovered = index;
    if (simulation.seed(index % WIDTH, Math.floor(index / WIDTH))) {
        planted = index;
        plantedUntil = performance.now() + 700;
    }
    draw();
    updateReadout();
}

if ('PointerEvent' in window) {
    field.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    field.addEventListener('pointerup', event => {
        if (event.pointerId !== press?.id) return;
        const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        press = null;
        if (distance <= 10) {
            lastTap = { x: event.clientX, y: event.clientY, time: performance.now() };
            plant(indexAt(event));
        }
    });
    field.addEventListener('pointercancel', () => { press = null; });
}

field.addEventListener('click', event => {
    if (lastTap && performance.now() - lastTap.time < 500
            && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 12) return;
    plant(indexAt(event));
});

document.querySelector('#plant').addEventListener('click', () => {
    const box = viewport.getBoundingClientRect();
    const rect = field.getBoundingClientRect();
    const visibleWidth = Math.min(viewport.clientWidth, rect.right - box.left);
    const visibleHeight = Math.min(viewport.clientHeight, rect.bottom - box.top);
    const x = box.left + visibleWidth / 2;
    const y = box.top + visibleHeight / 2;
    const center = indexAt({ clientX: x, clientY: y });
    let nearest = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < WIDTH * HEIGHT; index++) {
        if (simulation.cells.has(index) || simulation.energy[index] >= SOIL_LIMIT
                || simulation.organic[index] >= SOIL_LIMIT) continue;
        const distance = Math.abs(index % WIDTH - center % WIDTH)
            + Math.abs(Math.floor(index / WIDTH) - Math.floor(center / WIDTH));
        if (distance < bestDistance) {
            nearest = index;
            bestDistance = distance;
        }
    }
    plant(nearest);
});
field.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') hovered = indexAt(event);
});
field.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'touch') hovered = -1;
});
pause.addEventListener('click', () => {
    paused = !paused;
    pause.textContent = paused ? 'Продолжить' : 'Пауза';
});
function setZoom(value, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
    const next = Math.max(1, Math.min(10, value));
    const previousWidth = field.getBoundingClientRect().width;
    const ratio = WIDTH * next / previousWidth;
    zoom.value = String(next);
    zoomOut.disabled = next === 1;
    zoomIn.disabled = next === 10;
    field.style.width = `${WIDTH * next}px`;
    viewport.scrollLeft = (viewport.scrollLeft + anchorX) * ratio - anchorX;
    viewport.scrollTop = (viewport.scrollTop + anchorY) * ratio - anchorY;
}

zoom.addEventListener('change', () => setZoom(Number(zoom.value)));
zoomOut.addEventListener('click', () => setZoom(Number(zoom.value) - 1));
zoomIn.addEventListener('click', () => setZoom(Number(zoom.value) + 1));
viewport.addEventListener('wheel', event => {
    if (!event.deltaY || event.ctrlKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    setZoom(Number(zoom.value) - Math.sign(event.deltaY), event.clientX - rect.left, event.clientY - rect.top);
    hovered = indexAt(event);
}, { passive: false });
const fit = Math.floor(viewport.clientWidth / WIDTH);
setZoom(Math.min(Number(zoom.value), fit), 0, 0);
speed.addEventListener('change', () => { elapsed = 0; });
document.querySelector('#reset').addEventListener('click', () => {
    deathEffects.clear();
    simulation = new Simulation(Math.random, recordDeath);
    elapsed = 0;
    hovered = -1;
    planted = -1;
});

function frame(now) {
    if (!paused) {
        const multiplier = Number(speed.value);
        elapsed = Math.min(elapsed + (now - previous) / 1000 * multiplier,
            MAX_BACKLOG_SECONDS * multiplier + STEP);
        const deadline = performance.now() + FRAME_SIMULATION_BUDGET;
        while (elapsed >= STEP && performance.now() < deadline) {
            simulation.tick();
            elapsed -= STEP;
        }
    }
    previous = now;
    draw();
    updateReadout();
    requestAnimationFrame(frame);
}

draw();
updateReadout();
document.querySelector('#startup').hidden = true;
requestAnimationFrame(frame);
