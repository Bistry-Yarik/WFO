import { Simulation, STEP, DEFAULT_LIMITS, DIRECTIONS, ENERGY_RESOURCE, ORGANIC_RESOURCE, RADIATION_RESOURCE } from './simulation.mjs';
import { WorldAudio } from './audio.mjs';

const field = document.querySelector('#field');
const screen = field.getContext('2d');
const worldCanvas = document.createElement('canvas');
const context = worldCanvas.getContext('2d');
const scale = 10;
let terrain;
let terrainContext;
const MAX_CACHED_DETAIL_CELLS = 40_000;
let terrainPixels;
const pause = document.querySelector('#pause');
const speed = document.querySelector('#speed');
const actualSpeed = document.querySelector('#actual-speed');
const zoom = document.querySelector('#zoom');
const zoomLevels = Array.from(zoom.options, option => Number(option.value));
const gestureZoomOption = document.createElement('option');
const touchPointers = new Map();
const fieldSizeForm = document.querySelector('#field-size');
const fieldWidth = document.querySelector('#field-width');
const seedPack = document.querySelector('#seed-pack');
const seedRadius = document.querySelector('#seed-radius');
const mapTool = document.querySelector('#map-tool');
const viewport = document.querySelector('.viewport');
const graphicsSettings = document.querySelector('#graphics-settings');
const graphicsMode = document.querySelector('#graphics-mode');
const effectsEnabled = document.querySelector('#show-effects');
const soundEnabled = document.querySelector('#sound-enabled');
const soundStatus = document.querySelector('#sound-status');
const familyColors = document.querySelector('#show-family-colors');
const fieldPanel = viewport.closest('.field-panel');
const fullscreen = document.querySelector('#fullscreen');
const zoomOut = document.querySelector('#zoom-out');
const resetAngle = document.querySelector('#reset-angle');
const rotationEnabled = document.querySelector('#enable-rotation');
const zoomIn = document.querySelector('#zoom-in');
const touch = matchMedia('(hover: none)').matches;
const inspectHint = touch ? 'Коснитесь клетки, чтобы увидеть ресурсы' : 'Наведите на клетку, чтобы увидеть ресурсы';
const clock = document.querySelector('#clock');
const phase = document.querySelector('#phase');
const stats = document.querySelector('#stats');
const inspect = document.querySelector('#inspect');
const limitsForm = document.querySelector('#limits');
const limitStatus = document.querySelector('#limit-status');
const soilLimitLabel = document.querySelector('#soil-limit-label');
const settingKeys = Object.keys(DEFAULT_LIMITS);
const cameraKeys = new Set();
const camera = { x: 0, y: 0, zoom: 1, angle: 0 };
const cameraBindings = { KeyW: [0, -1], KeyA: [-1, 0], KeyS: [0, 1], KeyD: [1, 0] };
const SIMULATION_SLICE_MS = 8;
const FAST_SIMULATION_SLICE_MS = 16;
const COMPUTE_PRIORITY_SPEED = 500;
const CONTINUOUS_SPEED = 150;
const simulationTasks = new MessageChannel();
const FAST_DRAW_INTERVAL = 1000 / 30;
const COMPUTE_PRIORITY_DRAW_INTERVAL = 1000 / 20;
const DENSE_DRAW_INTERVAL = 100;
const MAX_BACKLOG_SECONDS = 0.1;
const DEATH_EFFECT_MS = 650;
const MAX_DEATH_EFFECTS = 160;
const OVERVIEW_MAX_ZOOM = 2;
const VECTOR_DETAIL_ZOOM = 20;
const RADIATION_PALE_LIMIT = 1000;
const RADIATION_TINT_WEIGHT = 2.5;
const resourceRingColors = [
    [ENERGY_RESOURCE, '#69b3ff'],
    [ORGANIC_RESOURCE, '#ff7885'],
    [RADIATION_RESOURCE, '#65e592']
];
const FAST_OVERVIEW_MAX_ZOOM = 5;
const DENSE_MAP_CELLS = 1500;
const overviewColors = {
    chlorophyll: [101, 229, 146],
    organic: [246, 107, 119],
    energy: [105, 179, 255],
    converter: [197, 138, 255],
    teeth: [165, 43, 58],
    blueTeeth: [47, 108, 224],
    cleaner: [255, 198, 91],
    stomach: [255, 152, 51]
};
const directionIcons = ['↑', '→', '↓', '←'];
const names = {
    adaptive: 'Сборщик по ресурсам', seed: 'Семечко', channel: 'Канал', chlorophyll: 'Хлорофилл',
    organic: 'Сборщик органики', energy: 'Сборщик энергии', converter: 'Преобразователь', teeth: 'Зубы', blueTeeth: 'Синие зубы', cleaner: 'Очиститель радиации', stomach: 'Желудок'
};

const deathEffects = new Map();
let worldAudio = null;
let simulation = new Simulation(Math.random, recordDeath, readLimits());
let paused = false;
let hovered = -1;
let press = null;
let pinch = null;
let touchGesture = false;
let lastTap = null;
let planted = -1;
let plantedUntil = 0;
let elapsed = 0;
let previous = performance.now();
let simulationUpdatedAt = previous;
let simulationTaskPending = false;
let lastDraw = 0;
let speedSampleAt = previous;
let speedSampleTime = 0;

function configureWorldCanvas({ width, height } = simulation) {
    const nextTerrain = document.createElement('canvas');
    nextTerrain.width = width;
    nextTerrain.height = height;
    const nextContext = nextTerrain.getContext('2d');
    // Canvas can accept dimensions beyond what the browser can actually draw.
    nextContext.fillRect(0, 0, 1, 1);
    if (!nextContext.getImageData(0, 0, 1, 1).data[3]) throw new RangeError('Canvas allocation failed');
    const nextPixels = nextContext.createImageData(width, height);
    const cacheDetail = width * height <= MAX_CACHED_DETAIL_CELLS;
    worldCanvas.width = cacheDetail ? width * scale : 1;
    worldCanvas.height = cacheDetail ? height * scale : 1;
    terrain = nextTerrain;
    terrainContext = nextContext;
    terrainPixels = nextPixels;
    context.imageSmoothingEnabled = false;
    field.setAttribute('aria-label', `Поле ${width} на ${height} клеток. Нажмите, чтобы посадить семечко.`);
}

function channelStockColor(cell) {
    const limit = simulation.limits.stop;
    const red = Math.round(82 + 173 * Math.min(cell.organic / limit, 1));
    const blue = Math.round(82 + 173 * Math.min(cell.energy / limit, 1));
    return [red, 82, blue];
}

function drawCell(cell, target = context) {
    const { width } = simulation;
    const x = (cell.index % width + (cell.host ? 0.73 : 0.5)) * scale;
    const y = (Math.floor(cell.index / width) + (cell.host ? 0.3 : 0.5)) * scale;
    let color = '#fff';
    if (familyColors.checked) color = `hsl(${cell.colony.hue} 80% 70%)`;
    else if (cell.type === 'channel') color = `rgb(${channelStockColor(cell).join(' ')})`;
    target.fillStyle = color;
    if (cell.type === 'channel') {
        target.strokeStyle = color;
        target.lineWidth = Math.max(scale / camera.zoom, 1.4 + Math.min(cell.flow / simulation.limits.flow, 1) * 6.6);
        target.lineCap = 'round';
        target.beginPath();
        simulation.neighbors(cell.index).forEach((index, direction) => {
            const neighbor = simulation.cells.get(index);
            if (!neighbor || neighbor.colony.family !== cell.colony.family) return;
            const [dx, dy] = DIRECTIONS[direction];
            const length = !familyColors.checked && neighbor.type === 'channel' ? scale / 2 : scale;
            const nx = x + dx * length;
            const ny = y + dy * length;
            target.moveTo(x, y);
            target.lineTo(nx, ny);
            const offsetX = nx < 0 ? simulation.width * scale : nx >= simulation.width * scale ? -simulation.width * scale : 0;
            const offsetY = ny < 0 ? simulation.height * scale : ny >= simulation.height * scale ? -simulation.height * scale : 0;
            if (target === context && (offsetX || offsetY)) {
                target.moveTo(x + offsetX, y + offsetY);
                target.lineTo(nx + offsetX, ny + offsetY);
            }
        });
        target.stroke();
        target.beginPath();
        target.arc(x, y, Math.max(scale * 1.1 / camera.zoom, target.lineWidth / 2), 0, Math.PI * 2);
        target.fill();
    } else if (cell.type === 'seed') {
        target.beginPath();
        target.arc(x, y, 3.7, 0, Math.PI * 2);
        target.fill();
    } else if (cell.type === 'chlorophyll') {
        target.fillStyle = '#65e592';
        target.beginPath();
        target.moveTo(x, y - 4.3);
        target.lineTo(x + 4.3, y);
        target.lineTo(x, y + 4.3);
        target.lineTo(x - 4.3, y);
        target.fill();
    } else if (cell.type === 'converter' || cell.type === 'teeth' || cell.type === 'blueTeeth' || cell.type === 'cleaner' || cell.type === 'stomach') {
        const sides = { teeth: 3, blueTeeth: 3, converter: 5, cleaner: 6, stomach: 10 }[cell.type];
        target.fillStyle = `rgb(${overviewColors[cell.type].join(' ')})`;
        target.beginPath();
        for (let point = 0; point < sides; point++) {
            const angle = -Math.PI / 2 + point * 2 * Math.PI / sides;
            const radius = cell.host ? 2.5 : cell.type === 'stomach' && point % 2 ? 2.05 : 4.3;
            const px = x + Math.cos(angle) * radius;
            const py = y + Math.sin(angle) * radius;
            if (point === 0) target.moveTo(px, py);
            else target.lineTo(px, py);
        }
        target.closePath();
        target.fill();
    } else {
        target.fillStyle = cell.type === 'organic' ? '#f66b77' : '#69b3ff';
        target.fillRect(x - 3.6, y - 3.6, 7.2, 7.2);
    }
}

function recordDeath(index, cause, resources) {
    worldAudio?.record('death', index);
    if (!effectsEnabled.checked) return;
    if (cause !== 'impact' && (deathEffects.size >= MAX_DEATH_EFFECTS || deathEffects.has(index))) return;
    if (deathEffects.size >= MAX_DEATH_EFFECTS && !deathEffects.has(index)) {
        deathEffects.delete(deathEffects.keys().next().value);
    }
    deathEffects.set(index, { cause, resources, start: performance.now() });
}

function wrappedArc(x, y, radius, start, end, target = context) {
    const width = simulation.width * scale;
    const height = simulation.height * scale;
    const offsetX = x - radius < 0 ? width : x + radius > width ? -width : 0;
    const offsetY = y - radius < 0 ? height : y + radius > height ? -height : 0;
    for (const dx of offsetX ? [0, offsetX] : [0]) {
        for (const dy of offsetY ? [0, offsetY] : [0]) {
            target.moveTo(x + dx + radius * Math.cos(start), y + dy + radius * Math.sin(start));
            target.arc(x + dx, y + dy, radius, start, end);
        }
    }
}

function drawDeathEffects(now, target = context) {
    const { width } = simulation;
    if (deathEffects.size === 0) return;
    target.save();
    target.lineWidth = 2;
    for (const [index, effect] of deathEffects) {
        const progress = (now - effect.start) / DEATH_EFFECT_MS;
        if (progress >= 1) {
            deathEffects.delete(index);
            continue;
        }

        const x = (index % width + 0.5) * scale;
        const y = (Math.floor(index / width) + 0.5) * scale;
        const impact = effect.cause === 'impact';
        const disconnected = effect.cause === 'disconnected';
        const expansion = disconnected || effect.cause === 'deficit' ? 1 - progress : progress;
        const radius = 2 + (impact ? 20 : 16) * expansion;
        const segments = impact || disconnected ? [[0, '#fff']] : resourceRingColors.filter(([resource]) => effect.resources & resource);
        const sweep = 2 * Math.PI / segments.length;
        target.globalAlpha = 1 - progress;
        for (let i = 0; i < segments.length; i++) {
            target.strokeStyle = segments[i][1];
            target.beginPath();
            wrappedArc(x, y, radius, i * sweep, (i + 1) * sweep, target);
            target.stroke();
        }
    }
    target.restore();
}

function drawOverview() {
    const pixels = terrainPixels.data;
    const palette = new Map();
    for (const [index, cell] of simulation.cells) {
        let color = overviewColors[cell.type];
        if (!color && !familyColors.checked) {
            color = cell.type === 'channel' ? channelStockColor(cell) : [255, 255, 255];
        }
        if (!color) {
            const hue = cell.colony.hue;
            if (!palette.has(hue)) {
                const component = n => {
                    const k = (n + hue / 30) % 12;
                    return 255 * (0.7 - 0.24 * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
                };
                palette.set(hue, [component(0), component(8), component(4)]);
            }
            color = palette.get(hue);
        }
        pixels.set(color, index * 4);
    }
    for (const [index, parasite] of simulation.parasites) pixels.set(overviewColors[parasite.type], index * 4);
    terrainContext.putImageData(terrainPixels, 0, 0);
    terrainContext.save();
    terrainContext.scale(1 / scale, 1 / scale);
    drawEffects(terrainContext);
    terrainContext.restore();
    return terrain;
}

function draw() {
    const pixels = terrainPixels.data;
    const { energy, organic, radiation, daylight, width } = simulation;
    const soilLimit = simulation.limits.soil;
    const pixelsPerCell = camera.zoom;
    const visibleArea = field.width * field.height / (pixelsPerCell * pixelsPerCell);
    const autoOverview = pixelsPerCell <= OVERVIEW_MAX_ZOOM
        || (worldCanvas.width === 1 && visibleArea >= energy.length)
        || (simulation.cells.size >= DENSE_MAP_CELLS
            && (Number(speed.value) >= COMPUTE_PRIORITY_SPEED || (Number(speed.value) > 250 && pixelsPerCell <= FAST_OVERVIEW_MAX_ZOOM)));
    const useOverview = graphicsMode.value === 'overview'
        || (graphicsMode.value === 'auto' && pixelsPerCell < VECTOR_DETAIL_ZOOM && autoOverview);
    const vectorDetail = !useOverview && (graphicsMode.value === 'detail'
        || pixelsPerCell >= VECTOR_DETAIL_ZOOM || visibleArea < energy.length);
    for (let index = 0; index < energy.length; index++) {
        const blue = Math.min(energy[index] / soilLimit, 1);
        const red = Math.min(organic[index] / soilLimit, 1);
        const green = Math.min(radiation[index] * RADIATION_TINT_WEIGHT / soilLimit, 1);
        const checker = !useOverview && (index % width + Math.floor(index / width)) % 2 === 0 ? 4 : 0;
        const offset = index * 4;
        const concentrated = energy[index] >= soilLimit || organic[index] >= soilLimit
            || radiation[index] >= RADIATION_PALE_LIMIT;
        const pale = concentrated ? 0.46 : 0;
        pixels[offset] = (16 + checker + 166 * red + 24 * green + 20 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 1] = ((daylight ? 29 : 19) + checker + 20 * red + 155 * green + 40 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 2] = ((daylight ? 24 : 32) + checker + 36 * red + 30 * green + 175 * blue) * (1 - pale) + 255 * pale;
        pixels[offset + 3] = 255;
    }
    let tile;
    if (vectorDetail) {
        terrainContext.putImageData(terrainPixels, 0, 0);
        tile = terrain;
    } else {
        tile = useOverview ? drawOverview() : drawDetailedWorld();
    }
    const matrix = viewMatrix();
    screen.imageSmoothingEnabled = false;
    const pattern = screen.createPattern(tile, 'repeat');
    pattern.setTransform(matrix.scale(simulation.width / tile.width, simulation.height / tile.height));
    screen.fillStyle = pattern;
    screen.fillRect(0, 0, field.width, field.height);
    if (vectorDetail) drawVisibleCells(matrix);
}

function drawVisibleCells(matrix) {
    const { width, height, cells, parasites } = simulation;
    const channels = [];
    const otherCells = [];
    const attached = [];
    const inverse = matrix.inverse();
    const corners = [[0, 0], [field.width, 0], [0, field.height], [field.width, field.height]]
        .map(([x, y]) => inverse.transformPoint({ x, y }));
    const startX = Math.floor(Math.min(...corners.map(point => point.x))) - 1;
    const endX = Math.ceil(Math.max(...corners.map(point => point.x))) + 1;
    const startY = Math.floor(Math.min(...corners.map(point => point.y))) - 1;
    const endY = Math.ceil(Math.max(...corners.map(point => point.y))) + 1;
    for (let y = startY; y < endY; y++) {
        const row = wrap(y, height);
        for (let x = startX; x < endX; x++) {
            const column = wrap(x, width);
            const index = row * width + column;
            const cell = cells.get(index);
            if (!cell) continue;
            const offsetX = x - column;
            const offsetY = y - row;
            const layer = cell.type === 'channel' ? channels : otherCells;
            layer.push({ cell, offsetX, offsetY });
            const parasite = parasites.get(index);
            if (parasite) attached.push({ cell: parasite, offsetX, offsetY });
        }
    }

    screen.save();
    const { a, b, c, d, e, f } = matrix;
    for (const layer of [channels, otherCells, attached]) {
        for (const { cell, offsetX, offsetY } of layer) {
            screen.setTransform(a / scale, b / scale, c / scale, d / scale,
                e + a * offsetX + c * offsetY, f + b * offsetX + d * offsetY);
            drawCell(cell, screen);
        }
    }
    if (effectsEnabled.checked && (deathEffects.size || planted >= 0)) {
        for (let y = Math.floor(startY / height) * height; y < endY; y += height) {
            for (let x = Math.floor(startX / width) * width; x < endX; x += width) {
                screen.save();
                screen.setTransform(matrix.translate(x, y).scale(1 / scale));
                screen.beginPath();
                screen.rect(0, 0, width * scale, height * scale);
                screen.clip();
                drawEffects(screen);
                screen.restore();
            }
        }
    }
    screen.restore();
}

function drawDetailedWorld() {
    terrainContext.putImageData(terrainPixels, 0, 0);
    context.drawImage(terrain, 0, 0, worldCanvas.width, worldCanvas.height);
    for (const cell of simulation.cells.values()) {
        if (cell.type === 'channel') drawCell(cell);
    }
    for (const cell of simulation.cells.values()) {
        if (cell.type !== 'channel') drawCell(cell);
    }
    for (const parasite of simulation.parasites.values()) drawCell(parasite);
    drawEffects(context);
    return worldCanvas;
}

function drawEffects(target) {
    if (!effectsEnabled.checked) return;
    const now = performance.now();
    drawDeathEffects(now, target);
    if (planted >= 0 && now < plantedUntil) {
        const { width } = simulation;
        const x = (planted % width + 0.5) * scale;
        const y = (Math.floor(planted / width) + 0.5) * scale;
        target.strokeStyle = '#fff';
        target.lineWidth = 2;
        target.beginPath();
        wrappedArc(x, y, 9, 0, Math.PI * 2, target);
        target.stroke();
    }
}

const statRows = [
    ['Колонии', () => simulation.colonies.size],
    ['Живые клетки', () => simulation.cells.size + simulation.parasites.size],
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
    const soil = `Вода ⚡ ${Math.floor(simulation.energy[hovered])} / орг. ${Math.floor(simulation.organic[hovered])} / рад. ${Math.floor(simulation.radiation[hovered])}`;
    const parasite = simulation.parasites.get(hovered);
    const parasiteDetails = parasite ? ` · ${names[parasite.type]} (паразит) · ⚡ ${Math.floor(parasite.energy)} / орг. ${Math.floor(parasite.organic)}` : '';
    const needs = cell?.colony.seedNeeds;
    const thirst = cell?.colony.thirsty ? ' · Жажда органики' : '';
    let channelDetails = '';
    if (cell?.type === 'channel') {
        const { genome } = cell.colony;
        const step = cell.gene % genome.length;
        const { type, direction, seekRadiation, wormRole } = genome[step];
        const command = wormRole === 'turn' ? 'Поворот семечком' : `${names[type]} ${seekRadiation ? 'к радиации' : directionIcons[direction]}`;
        channelDetails = ` · Ген ${step + 1}/${genome.length}: ${command}`
            + ` · Пороги семени (энергия/органика): рядом ${needs.energy}/${needs.organic}, бросок ${needs.throwEnergy}/${needs.organic}`;
    }
    inspect.textContent = cell
        ? `${names[cell.type]} · ⚡ ${Math.floor(cell.energy)} / орг. ${Math.floor(cell.organic)}${thirst}${channelDetails}${parasiteDetails} · ${soil}`
        : soil;
}

function wrap(value, size) {
    return ((value % size) + size) % size;
}

function moveCamera(dx, dy) {
    camera.x = wrap(camera.x + dx, simulation.width);
    camera.y = wrap(camera.y + dy, simulation.height);
}

function viewMatrix() {
    if (camera.angle === 0) {
        return new DOMMatrix([camera.zoom, 0, 0, camera.zoom,
            -Math.round(camera.x * camera.zoom), -Math.round(camera.y * camera.zoom)]);
    }
    return new DOMMatrix().rotate(camera.angle * 180 / Math.PI).scale(camera.zoom)
        .translate(-camera.x, -camera.y);
}

function cameraOffset(x, y) {
    const cos = Math.cos(camera.angle);
    const sin = Math.sin(camera.angle);
    return { x: (cos * x + sin * y) / camera.zoom, y: (-sin * x + cos * y) / camera.zoom };
}

function moveCameraByScreen(x, y) {
    const offset = cameraOffset(x, y);
    moveCamera(offset.x, offset.y);
}

function setAngle(angle, anchorX = field.width / 2, anchorY = field.height / 2) {
    const before = cameraOffset(anchorX, anchorY);
    camera.angle = wrap(angle + Math.PI, 2 * Math.PI) - Math.PI;
    const after = cameraOffset(anchorX, anchorY);
    moveCamera(before.x - after.x, before.y - after.y);
    resetAngle.disabled = camera.angle === 0;
}

function rotateWithMouse(fromX, fromY, toX, toY) {
    const rect = field.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const ax = fromX - centerX;
    const ay = fromY - centerY;
    const bx = toX - centerX;
    const by = toY - centerY;
    const deadZone = 8;
    if (Math.hypot(ax, ay) < deadZone || Math.hypot(bx, by) < deadZone) return;
    const cross = ax * by - ay * bx;
    const dot = ax * bx + ay * by;
    if (dot < 0 && Math.abs(cross) < deadZone * Math.hypot(bx - ax, by - ay)) return;
    setAngle(camera.angle + Math.atan2(cross, dot));
}

resetAngle.addEventListener('click', () => setAngle(0));
rotationEnabled.addEventListener('change', () => {
    if (!rotationEnabled.checked) setAngle(0);
});

function indexAt(event) {
    const rect = field.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) return -1;
    const position = viewMatrix().inverse().transformPoint({ x: px, y: py });
    return wrap(Math.floor(position.y), simulation.height) * simulation.width
        + wrap(Math.floor(position.x), simulation.width);
}

function plant(index) {
    const { width } = simulation;
    if (index < 0) return;
    hovered = index;
    if (simulation.plantSeedPack(index % width, Math.floor(index / width), seedPack.value, Number(seedRadius.value))) {
        planted = index;
        plantedUntil = performance.now() + 700;
        fieldSizeForm.hidden = true;
    }
    draw();
    updateReadout();
}

function paintStroke(fromX, fromY, event, tool, visited) {
    const rect = field.getBoundingClientRect();
    const inverse = viewMatrix().inverse();
    const toMap = (x, y) => inverse.transformPoint({
        x: Math.max(0, Math.min(rect.width - 0.001, x - rect.left)),
        y: Math.max(0, Math.min(rect.height - 0.001, y - rect.top))
    });
    const from = toMap(fromX, fromY);
    const to = toMap(event.clientX, event.clientY);
    const x0 = Math.floor(from.x), y0 = Math.floor(from.y);
    const dx = Math.floor(to.x) - x0, dy = Math.floor(to.y) - y0;
    const count = Math.max(1, Math.abs(dx), Math.abs(dy));
    const radius = Number(seedRadius.value);
    const indices = [];
    for (let step = 0; step <= count; step++) {
        const x = x0 + Math.round(dx * step / count);
        const y = y0 + Math.round(dy * step / count);
        for (let ry = -radius; ry <= radius; ry++) {
            for (let rx = -radius; rx <= radius; rx++) {
                if (rx * rx + ry * ry > radius * radius) continue;
                const index = wrap(y + ry, simulation.height) * simulation.width + wrap(x + rx, simulation.width);
                if (visited.has(index)) continue;
                visited.add(index);
                indices.push(index);
            }
        }
    }
    if (indices.length) {
        simulation.paintWater(indices, tool);
        hovered = indexAt(event);
        draw();
        updateReadout();
    }
}

function useMapTool(event) {
    const index = indexAt(event);
    if (index < 0) return;
    if (mapTool.value === 'seed') plant(index);
    else paintStroke(event.clientX, event.clientY, event, mapTool.value, new Set());
}

function touchPair() {
    const points = touchPointers.values();
    const first = points.next().value;
    const second = points.next().value;
    return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        angle: Math.atan2(second.y - first.y, second.x - first.x)
    };
}

function startPinch() {
    pinch = { ...touchPair(), zoom: camera.zoom };
    touchGesture = true;
    press = null;
}

function releaseTouch(event) {
    if (!touchPointers.delete(event.pointerId)) return false;
    const wasGesture = touchGesture;
    if (wasGesture) {
        lastTap = { x: event.clientX, y: event.clientY, time: performance.now() };
        if (touchPointers.size >= 2) startPinch();
        else pinch = null;
        if (touchPointers.size === 0) touchGesture = false;
    }
    return wasGesture;
}

if ('PointerEvent' in window) {
    field.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch') {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (touchPointers.size >= 2) {
                field.setPointerCapture(event.pointerId);
                startPinch();
                return;
            }
        }
        const canPlant = event.button === 0;
        const rightDrag = event.button === 2 && event.pointerType === 'mouse';
        const rotating = rotationEnabled.checked && event.button === 1 && event.pointerType === 'mouse';
        if (!event.isPrimary || (!canPlant && !rightDrag && !rotating)) return;
        if (rotating) event.preventDefault();
        const paintTool = canPlant && mapTool.value !== 'seed' ? mapTool.value : null;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY,
            dragging: rightDrag || rotating, canPlant, rotating, paintTool,
            visited: paintTool ? new Set() : null };
        field.setPointerCapture(event.pointerId);
    });
    field.addEventListener('pointermove', event => {
        if (touchPointers.has(event.pointerId)) {
            touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pinch) {
                const pair = touchPair();
                const rect = field.getBoundingClientRect();
                setZoom(pinch.zoom * pair.distance / pinch.distance, pinch.x - rect.left, pinch.y - rect.top);
                if (rotationEnabled.checked) {
                    setAngle(camera.angle + pair.angle - pinch.angle, pinch.x - rect.left, pinch.y - rect.top);
                }
                moveCameraByScreen(pinch.x - pair.x, pinch.y - pair.y);
                pinch.angle = pair.angle;
                pinch.x = pair.x;
                pinch.y = pair.y;
                return;
            }
        }
        if (event.pointerId !== press?.id) return;
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        if (!press.dragging && Math.hypot(dx, dy) <= (press.paintTool ? 4 : 10)) return;
        if (press.rotating) {
            if (rotationEnabled.checked) rotateWithMouse(press.x, press.y, event.clientX, event.clientY);
        } else if (press.paintTool) {
            paintStroke(press.x, press.y, event, press.paintTool, press.visited);
        } else moveCameraByScreen(-dx, -dy);
        Object.assign(press, { x: event.clientX, y: event.clientY, dragging: true });
    });
    field.addEventListener('pointerup', event => {
        if (releaseTouch(event) || event.pointerId !== press?.id) return;
        if (press.paintTool && press.dragging) {
            paintStroke(press.x, press.y, event, press.paintTool, press.visited);
        }
        const stationary = press.canPlant && !press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 10;
        press = null;
        lastTap = { x: event.clientX, y: event.clientY, time: performance.now() };
        if (stationary) useMapTool(event);
    });
    const cancelPointer = event => {
        releaseTouch(event);
        if (event.pointerId === press?.id) press = null;
    };
    field.addEventListener('pointercancel', cancelPointer);
    field.addEventListener('lostpointercapture', cancelPointer);
}

field.addEventListener('contextmenu', event => event.preventDefault());
field.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
field.addEventListener('click', event => {
    if (touchGesture) return;
    if (lastTap && performance.now() - lastTap.time < 500
            && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 12) return;
    useMapTool(event);
});

const plantButton = document.querySelector('#plant');
seedRadius.addEventListener('change', () => {
    plantButton.textContent = seedRadius.value === '0' ? 'Посадить семечко' : 'Рассыпать семечки';
});
plantButton.addEventListener('click', () => {
    const { width, height } = simulation;
    const rect = field.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const center = indexAt({ clientX: x, clientY: y });
    let nearest = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < simulation.energy.length; index++) {
        if (simulation.cells.has(index) || !simulation.isSeedSiteSafe(index)) continue;
        const dx = Math.abs(index % width - center % width);
        const dy = Math.abs(Math.floor(index / width) - Math.floor(center / width));
        const distance = Math.min(dx, width - dx) + Math.min(dy, height - dy);
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
    resetSpeedSample();
});
function sizeView() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    if (field.width === width && field.height === height) return;
    moveCameraByScreen((field.width - width) / 2, (field.height - height) / 2);
    field.width = width;
    field.height = height;
    screen.imageSmoothingEnabled = false;
}

function setZoom(value, anchorX = field.width / 2, anchorY = field.height / 2) {
    const before = cameraOffset(anchorX, anchorY);
    const minimum = zoomLevels[0];
    const maximum = zoomLevels[zoomLevels.length - 1];
    camera.zoom = Math.max(minimum, Math.min(maximum, Math.round(value * 100) / 100));
    if (zoomLevels.includes(camera.zoom)) {
        gestureZoomOption.remove();
    } else {
        gestureZoomOption.value = String(camera.zoom);
        gestureZoomOption.textContent = `${camera.zoom.toLocaleString('ru')}×`;
        if (!gestureZoomOption.parentNode) zoom.append(gestureZoomOption);
    }
    zoom.value = String(camera.zoom);
    zoomOut.disabled = camera.zoom === minimum;
    zoomIn.disabled = camera.zoom === maximum;
    const after = cameraOffset(anchorX, anchorY);
    moveCamera(before.x - after.x, before.y - after.y);
}

zoom.addEventListener('change', () => setZoom(Number(zoom.value)));
function stepZoom(direction, x, y) {
    const next = direction > 0
        ? zoomLevels.find(level => level > camera.zoom)
        : zoomLevels.findLast(level => level < camera.zoom);
    if (next !== undefined) setZoom(next, x, y);
}

zoomOut.addEventListener('click', () => stepZoom(-1));
zoomIn.addEventListener('click', () => stepZoom(1));
field.addEventListener('wheel', event => {
    if (!event.deltaY || event.ctrlKey) return;
    event.preventDefault();
    const rect = field.getBoundingClientRect();
    stepZoom(-Math.sign(event.deltaY), event.clientX - rect.left, event.clientY - rect.top);
    hovered = indexAt(event);
}, { passive: false });
sizeView();
setZoom(Number(zoom.value));
new ResizeObserver(sizeView).observe(viewport);
function validLimits(limits) {
    return limits && settingKeys.every(key => Number.isSafeInteger(limits[key])
        && limits[key] >= (key === 'slowdown' ? 0 : 1)) && limits.slowdown < limits.stop;
}

function readLimits() {
    try {
        const stored = JSON.parse(localStorage.getItem('wfo-limits'));
        if (validLimits(stored)) return stored;
    } catch {
        // Some browsers restrict storage for local HTML files.
    }
    return DEFAULT_LIMITS;
}

function showLimits() {
    for (const key of settingKeys) limitsForm.elements.namedItem(key).value = simulation.limits[key];
    soilLimitLabel.textContent = simulation.limits.soil;
}

limitsForm.addEventListener('submit', event => {
    event.preventDefault();
    const limits = Object.fromEntries(settingKeys.map(key => [key, limitsForm.elements.namedItem(key).valueAsNumber]));
    if (!validLimits(limits)) {
        limitStatus.textContent = 'Порог замедления должен быть ниже порога остановки.';
        return;
    }
    simulation.limits = limits;
    soilLimitLabel.textContent = limits.soil;
    limitStatus.textContent = 'Применено';
    try {
        localStorage.setItem('wfo-limits', JSON.stringify(limits));
    } catch {
        // The new limits still apply to this session.
    }
});
showLimits();

function updateFullscreen() {
    const expanded = document.fullscreenElement === fieldPanel || fieldPanel.classList.contains('is-expanded');
    fullscreen.textContent = expanded ? 'Выйти из полного экрана' : 'Во весь экран';
    fullscreen.setAttribute('aria-pressed', String(expanded));
}

async function toggleFullscreen() {
    if (document.fullscreenElement === fieldPanel) {
        await document.exitFullscreen();
    } else if (fieldPanel.classList.contains('is-expanded')) {
        fieldPanel.classList.remove('is-expanded');
    } else {
        fieldPanel.classList.add('is-expanded');
        updateFullscreen();
        try {
            await fieldPanel.requestFullscreen();
            if (fieldPanel.classList.contains('is-expanded')) {
                fieldPanel.classList.remove('is-expanded');
            } else if (document.fullscreenElement === fieldPanel) {
                await document.exitFullscreen();
            }
        } catch {
            // The expanded view works even when the browser blocks native fullscreen.
        }
    }
    updateFullscreen();
}

function recordBirth(index) {
    worldAudio?.record('birth', index);
}

async function toggleSound() {
    const previousAudio = worldAudio;
    worldAudio = null;
    simulation.onBirth = null;
    soundStatus.textContent = '';
    if (previousAudio) previousAudio.context.close().catch(() => {});
    if (!soundEnabled.checked) return;
    let audio;
    try {
        const AudioContext = window.AudioContext ?? window.webkitAudioContext;
        audio = new WorldAudio(AudioContext);
        worldAudio = audio;
        audio.setListener(simulation, camera, field);
        await audio.context.resume();
        if (worldAudio === audio) simulation.onBirth = recordBirth;
    } catch {
        if (audio && worldAudio !== audio) return;
        audio?.context.close().catch(() => {});
        worldAudio = null;
        soundEnabled.checked = false;
        soundStatus.textContent = 'Звук недоступен в этом браузере';
    }
}

soundEnabled.addEventListener('change', toggleSound);
document.addEventListener('visibilitychange', () => {
    if (!worldAudio) return;
    const context = worldAudio.context;
    const playback = document.hidden ? context.suspend() : context.resume();
    playback.catch(() => {});
});

document.querySelector('#open-graphics').addEventListener('click', () => graphicsSettings.showModal());
graphicsMode.addEventListener('change', draw);
effectsEnabled.addEventListener('change', () => {
    deathEffects.clear();
    planted = -1;
    draw();
});
familyColors.addEventListener('change', draw);

fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', updateFullscreen);
window.addEventListener('keydown', event => {
    if (event.code === 'F11' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (!event.repeat) toggleFullscreen();
    } else if (event.code === 'Escape' && fieldPanel.classList.contains('is-expanded')) {
        toggleFullscreen();
    }
});

window.addEventListener('keydown', event => {
    if (!cameraBindings[event.code] || event.ctrlKey || event.metaKey || event.altKey
            || event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    event.preventDefault();
    cameraKeys.add(event.code);
});
window.addEventListener('keyup', event => cameraKeys.delete(event.code));
window.addEventListener('blur', () => cameraKeys.clear());

function resetSpeedSample() {
    elapsed = 0;
    simulationUpdatedAt = performance.now();
    speedSampleAt = simulationUpdatedAt;
    speedSampleTime = simulation.time;
    actualSpeed.textContent = '';
}

speed.addEventListener('change', resetSpeedSample);
document.addEventListener('visibilitychange', resetSpeedSample);
function restart(width) {
    const resized = simulation.width !== width;
    let nextSimulation;
    try {
        if (!Number.isSafeInteger(width)) throw new RangeError('Invalid width');
        nextSimulation = new Simulation(Math.random, recordDeath, simulation.limits, width);
        if (resized) configureWorldCanvas(nextSimulation);
    } catch (error) {
        if (!(error instanceof RangeError || error instanceof DOMException)) throw error;
        fieldWidth.setCustomValidity('Браузер не смог создать поле такого размера. Укажите меньшую ширину.');
        fieldWidth.reportValidity();
        return;
    }
    deathEffects.clear();
    simulation = nextSimulation;
    if (resized) {
        camera.x = 0;
        camera.y = 0;
    }
    if (worldAudio) {
        simulation.onBirth = recordBirth;
        worldAudio.events = {};
        worldAudio.setListener(simulation, camera, field);
    }
    hovered = -1;
    planted = -1;
    fieldWidth.setCustomValidity('');
    fieldWidth.value = width;
    fieldSizeForm.hidden = false;
    resetSpeedSample();
}

fieldWidth.addEventListener('input', () => fieldWidth.setCustomValidity(''));
fieldSizeForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!fieldSizeForm.hidden && fieldWidth.validity.valid) restart(fieldWidth.valueAsNumber);
});
document.querySelector('#reset').addEventListener('click', () => restart(simulation.width));

function runSimulationSlice(multiplier) {
    const now = performance.now();
    elapsed = Math.min(elapsed + (now - simulationUpdatedAt) / 1000 * multiplier,
        MAX_BACKLOG_SECONDS * multiplier + STEP);
    simulationUpdatedAt = now;
    const slice = multiplier >= COMPUTE_PRIORITY_SPEED ? FAST_SIMULATION_SLICE_MS : SIMULATION_SLICE_MS;
    const deadline = now + slice;
    while (elapsed >= STEP && performance.now() < deadline) {
        simulation.tick();
        elapsed -= STEP;
    }
    if (multiplier >= CONTINUOUS_SPEED && elapsed >= STEP) {
        simulationTaskPending = true;
        simulationTasks.port2.postMessage(null);
    }
}

simulationTasks.port1.onmessage = () => {
    simulationTaskPending = false;
    const multiplier = Number(speed.value);
    if (!paused && !document.hidden && multiplier >= CONTINUOUS_SPEED) runSimulationSlice(multiplier);
};

function frame(now) {
    const delta = Math.min((now - previous) / 1000, 0.1);
    for (const key of cameraKeys) {
        const [dx, dy] = cameraBindings[key];
        const distance = delta * 420;
        moveCameraByScreen(dx * distance, dy * distance);
    }
    const multiplier = Number(speed.value);
    if (!paused && !document.hidden && !simulationTaskPending) {
        runSimulationSlice(multiplier);
    }
    previous = now;
    worldAudio?.update(now, simulation, camera, field);
    if (!paused && now - speedSampleAt >= 750) {
        const measured = (simulation.time - speedSampleTime) * 1000 / (now - speedSampleAt);
        actualSpeed.textContent = multiplier > 1 && measured < multiplier * 0.9
            ? `Фактически ≈${Math.round(measured)}×` : '';
        speedSampleAt = now;
        speedSampleTime = simulation.time;
    }
    let drawInterval = FAST_DRAW_INTERVAL;
    if (multiplier >= COMPUTE_PRIORITY_SPEED) {
        drawInterval = simulation.cells.size >= DENSE_MAP_CELLS ? DENSE_DRAW_INTERVAL : COMPUTE_PRIORITY_DRAW_INTERVAL;
    }
    if (multiplier <= 100 || cameraKeys.size || press || pinch || now - lastDraw >= drawInterval) {
        draw();
        updateReadout();
        lastDraw = now;
    }
    requestAnimationFrame(frame);
}

configureWorldCanvas();
draw();
updateReadout();
document.querySelector('#startup').hidden = true;
requestAnimationFrame(frame);
