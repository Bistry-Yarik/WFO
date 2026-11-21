export const WIDTH = 100;
export const HEIGHT = 64;
export const STEP = 0.1;
export const DEFAULT_LIMITS = Object.freeze({
    soil: 2500, flow: 2500, radiation: 5000, slowdown: 1000, stop: 1500
});
export const ENERGY_RESOURCE = 1;
export const ORGANIC_RESOURCE = 2;
export const RADIATION_RESOURCE = 4;
const RADIATION_LETHAL_ABOVE = 999;
export const TYPES = ['chlorophyll', 'organic', 'energy', 'channel', 'seed', 'converter', 'teeth', 'blueTeeth', 'cleaner', 'stomach'];
const GENOME_LENGTH = 9;
const MUTATION_TYPES = [...TYPES, 'adaptive'];
export const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const GROWTH_INTERVAL = 1.5;
const IDLE_RECYCLE_AGE = 30;
const RECYCLE_CHECK_TICKS = Math.round(1 / STEP);
const MIN_USEFUL_WORK = 0.01;
const RECYCLABLE_TYPES = new Set(['organic', 'energy', 'teeth', 'cleaner', 'converter', 'stomach']);
const MUTATION_CHANCE = 0.02;
const MAX_MUTATION_CHANCE = 0.5;
const DEATH_RADIATION = 300;
const MUTATION_RADIATION_DIVISOR = 1.5;
const CONVERSION_RATE = 150;
const RADIATION_CLEANUP_RATE = 50;
const CLEANUP_ENERGY_PER_RADIATION = 10 / 50;
const RADIATION_CLEANUP_MAX_RATE = 100;
const STRONG_RADIATION = 750;
const ORGANIC_THIRST_THRESHOLD = 100;
const ENERGY_UPKEEP = 5;
const ORGANIC_UPKEEP = 1;
const BOOST_START = 900;
const BOOST_FULL = 1400;

function productionFactor(stock, { slowdown, stop }) {
    return Math.max(0, Math.min(1, (stop - stock) / (stop - slowdown)));
}
function organicBoost(cell, base) {
    const { energy, colony } = cell;
    const factor = colony.thirsty ? 1 : Math.max(0, Math.min(1, (energy - BOOST_START) / (BOOST_FULL - BOOST_START)));
    return Math.min(base * factor, Math.max(0, energy - 2 * ENERGY_UPKEEP * STEP));
}

const NIGHT_ENERGY_RATE = 50;
const NIGHT_ORGANIC_RATE = 5;
const DAY_LENGTH = 450;
const CYCLE_LENGTH = 600;
const DIFFUSION_TICKS = 5;
const DIFFUSION_RATES = { energy: 0.006, organic: 0.0002, radiation: 0.002 };
const BITE_RATE = 1000;
const TOOTH_RESOURCE = { teeth: 'organic', blueTeeth: 'energy' };
const CELL_COST = { energy: 225, organic: 300 };
const CHANNEL_COST = { energy: 40, organic: 50 };
const SEED_COST = { energy: 170, organic: 75 };
const THROWN_SEED_COST = { energy: 500, organic: SEED_COST.organic };
const SEED_THROW_RANGE = 6;
const SEED_REQUIREMENT_BASE = { energy: 225, organic: 100, throwEnergy: 675 };
const SEED_REQUIREMENT_TRAITS = Object.keys(SEED_REQUIREMENT_BASE);

function randomRequirement(base, random, previous) {
    const min = Math.round(base * 0.8);
    const max = Math.round(base * 1.2);
    if (previous === undefined) return min + Math.floor(random() * (max - min + 1));
    const candidate = min + Math.floor(random() * (max - min));
    return candidate < previous ? candidate : candidate + 1;
}
const THROW_OFFSETS = [];
for (let dy = -SEED_THROW_RANGE; dy <= SEED_THROW_RANGE; dy++) {
    for (let dx = -SEED_THROW_RANGE; dx <= SEED_THROW_RANGE; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance >= 1 && distance <= SEED_THROW_RANGE) THROW_OFFSETS.push([dx, dy]);
    }
}

function randomGenome(random) {
    const types = ['chlorophyll', 'organic'];
    if (random() < 0.5) types.reverse();
    // The first two steps supply both resources. Later steps can repeat any type.
    while (types.length < GENOME_LENGTH) {
        types.push(TYPES[Math.floor(random() * TYPES.length)]);
    }
    return types.map(type => ({ type, direction: Math.floor(random() * DIRECTIONS.length) }));
}

const SPECIAL_PACKS = {
    solar: ['chlorophyll', 'converter', 'channel', 'chlorophyll', 'converter', 'chlorophyll', 'converter', 'organic', 'seed'],
    devourer: ['organic', 'stomach', 'channel', 'teeth', 'chlorophyll', 'organic', 'teeth', 'stomach', 'seed'],
    electric: ['energy', 'chlorophyll', 'channel', 'blueTeeth', 'converter', 'energy', 'chlorophyll', 'converter', 'energy', 'seed']
};

function packGenome(pack, random) {
    if (pack === 'worm') {
        const heading = Math.floor(random() * DIRECTIONS.length);
        return [
            { type: 'channel', direction: heading, preferBuild: true, branchStep: 0 },
            { type: 'adaptive', direction: (heading + 1) % 4, preferBuild: true },
            { type: 'teeth', direction: (heading + 3) % 4, preferBuild: true },
            { type: 'blueTeeth', direction: (heading + 1) % 4, preferBuild: true },
            { type: 'chlorophyll', direction: (heading + 3) % 4 }
        ];
    }
    if (pack === 'cleanup') {
        const heading = Math.floor(random() * DIRECTIONS.length);
        const left = (heading + 3) % 4;
        const right = (heading + 1) % 4;
        return [
            { type: 'chlorophyll', direction: (heading + 2) % 4, preferBuild: true },
            { type: 'channel', direction: heading, preferBuild: true, seekRadiation: true, branchStep: 4 },
            { type: 'converter', direction: right, preferBuild: true },
            { type: 'cleaner', direction: left, preferBuild: true, seekRadiation: true },
            { type: 'channel', direction: right, preferBuild: true, seekRadiation: true, branchStep: 4 },
            { type: 'cleaner', direction: left, preferBuild: true, seekRadiation: true },
            { type: 'converter', direction: right },
            { type: 'cleaner', direction: right, preferBuild: true, seekRadiation: true },
            { type: 'converter', direction: left },
            { type: 'seed', direction: heading }
        ];
    }
    const types = SPECIAL_PACKS[pack];
    return types
        ? types.map((type, step) => ({ type, direction: Math.floor(random() * DIRECTIONS.length), preferBuild: step < 2 }))
        : randomGenome(random);
}

function resourceMask(energy, organic) {
    return (energy ? ENERGY_RESOURCE : 0) | (organic ? ORGANIC_RESOURCE : 0);
}

export class Simulation {
    constructor(random = Math.random, onDeath = null, limits = DEFAULT_LIMITS, width = WIDTH) {
        this.random = random;
        this.onDeath = onDeath;
        this.onBirth = null;
        this.limits = limits;
        this.width = width;
        this.height = Math.round(width * HEIGHT / WIDTH);
        this.cells = new Map();
        this.parasites = new Map();
        this.colonies = new Map();
        this.tickCells = null;
        this.tickDaylight = null;
        this.transfers = [];
        this.overloaded = new Map();
        this.shadedColumns = new Uint8Array(width);
        this.energy = new Float64Array(this.width * this.height);
        this.radiation = new Float64Array(this.energy.length);
        this.neighborCache = new Array(this.energy.length);
        this.throwColumns = Array.from({ length: width }, (_, x) =>
            Uint16Array.from(THROW_OFFSETS, ([dx]) => (x + dx + width) % width));
        this.throwRows = Array.from({ length: this.height }, (_, y) =>
            Uint32Array.from(THROW_OFFSETS, ([, dy]) => ((y + dy + this.height) % this.height) * width));
        this.organic = Float64Array.from(this.energy, () => 350 + random() * 750);
        this.diffusionBuffers = {
            energy: new Float64Array(this.energy.length),
            organic: new Float64Array(this.energy.length),
            radiation: new Float64Array(this.energy.length)
        };
        this.time = 0;
        this.totalSeeds = 0;
        this.mutations = 0;
        this.overloads = 0;
    }

    get daylight() {
        return this.time % CYCLE_LENGTH < DAY_LENGTH;
    }

    seed(x, y, parent = null, cost = SEED_COST, pack = 'standard') {
        const index = y * this.width + x;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height || this.cells.has(index)) return false;
        const id = ++this.totalSeeds;
        const genome = parent ? parent.genome.map(command => ({ ...command })) : packGenome(pack, this.random);
        const seedNeeds = parent ? { ...parent.seedNeeds } : {};
        if (!parent) {
            for (const trait of SEED_REQUIREMENT_TRAITS) {
                seedNeeds[trait] = randomRequirement(SEED_REQUIREMENT_BASE[trait], this.random);
            }
        }
        const exposure = Math.min(this.radiation[index] / this.limits.radiation, 1);
        const mutationChance = MUTATION_CHANCE + exposure * (MAX_MUTATION_CHANCE - MUTATION_CHANCE);
        if (parent && this.random() < mutationChance) {
            const locus = Math.floor(this.random() * (2 * genome.length + SEED_REQUIREMENT_TRAITS.length));
            if (locus < genome.length) {
                const command = genome[locus];
                const alternatives = MUTATION_TYPES.filter(type => type !== command.type);
                const type = alternatives[Math.floor(this.random() * alternatives.length)];
                genome[locus] = { type, direction: command.direction };
            } else if (locus < 2 * genome.length) {
                const command = genome[locus - genome.length];
                const turn = 1 + Math.floor(this.random() * (DIRECTIONS.length - 1));
                command.direction = (command.direction + turn) % DIRECTIONS.length;
            } else {
                const trait = SEED_REQUIREMENT_TRAITS[locus - 2 * genome.length];
                seedNeeds[trait] = randomRequirement(SEED_REQUIREMENT_BASE[trait], this.random, seedNeeds[trait]);
            }
            this.mutations++;
            for (let ny = y - 1; ny <= y + 1; ny++) {
                for (let nx = x - 1; nx <= x + 1; nx++) {
                    this.radiation[this.wrappedIndex(nx, ny)] /= MUTATION_RADIATION_DIVISOR;
                }
            }
        }
        const colony = {
            id,
            hue: parent?.hue ?? (id * 137.508 + 25) % 360,
            family: parent?.family ?? id,
            genome,
            seedNeeds,
            thirsty: false,
            organicReserve: 0,
            reserveCells: 0
        };
        this.colonies.set(id, colony);
        const seed = parent
            ? this.makeCell(index, 'seed', colony, cost.energy, cost.organic)
            : this.makeCell(index, 'seed', colony, 1350);
        this.cells.set(index, seed);
        this.tickCells = null;
        this.onBirth?.(index);
        return true;
    }

    plantSeedPack(x, y, pack, radius) {
        if (radius === 0) return Number(this.seed(x, y, null, SEED_COST, pack));
        let planted = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx % 3 !== 0 || dy % 3 !== 0 || dx * dx + dy * dy > radius * radius) continue;
                const index = this.wrappedIndex(x + dx, y + dy);
                if (!this.isSeedSiteSafe(index)) continue;
                const nx = index % this.width;
                const ny = Math.floor(index / this.width);
                if (this.seed(nx, ny, null, SEED_COST, pack)) planted++;
            }
        }
        return planted;
    }

    makeCell(index, type, colony, energy, organic = energy) {
        return { index, type, colony, energy, organic, host: null, age: 0, lastWorkAge: 0, growth: 0, gene: 0, flow: 0, flowResources: 0 };
    }

    wrappedIndex(x, y) {
        const { width, height } = this;
        return ((y + height) % height) * width + (x + width) % width;
    }

    neighbors(index) {
        let neighbors = this.neighborCache[index];
        if (!neighbors) {
            const x = index % this.width;
            const y = Math.floor(index / this.width);
            neighbors = DIRECTIONS.map(([dx, dy]) => this.wrappedIndex(x + dx, y + dy));
            this.neighborCache[index] = neighbors;
        }
        return neighbors;
    }

    collect(cell, resource) {
        const ground = this[resource];
        const x = cell.index % this.width;
        const y = Math.floor(cell.index / this.width);
        const base = 50 * STEP * productionFactor(cell[resource], this.limits);
        if (base === 0) {
            cell.lastWorkAge = cell.age;
            return;
        }
        const bonus = resource === 'organic' ? organicBoost(cell, base) : 0;
        let remaining = base + bonus;
        for (let dy = -1; dy <= 1 && remaining > 0; dy++) {
            for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                const index = this.wrappedIndex(nx, ny);
                const amount = Math.min(remaining, ground[index]);
                ground[index] -= amount;
                cell[resource] += amount;
                remaining -= amount;
            }
        }
        if (base + bonus - remaining >= MIN_USEFUL_WORK) cell.lastWorkAge = cell.age;
        cell.energy -= Math.max(0, bonus - remaining);
    }

    cleanRadiation(cell) {
        const x = cell.index % this.width;
        const y = Math.floor(cell.index / this.width);
        let strongest = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                strongest = Math.max(strongest, this.radiation[this.wrappedIndex(x + dx, y + dy)]);
            }
        }
        const rate = strongest >= STRONG_RADIATION ? RADIATION_CLEANUP_MAX_RATE : RADIATION_CLEANUP_RATE;
        const budget = rate * STEP;
        let remaining = budget;
        for (let dy = -1; dy <= 1 && remaining > 0; dy++) {
            for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
                const index = this.wrappedIndex(x + dx, y + dy);
                const removed = Math.min(this.radiation[index], remaining);
                this.radiation[index] -= removed;
                remaining -= removed;
            }
        }
        const removed = budget - remaining;
        if (removed >= MIN_USEFUL_WORK) cell.lastWorkAge = cell.age;
        cell.energy += removed * CLEANUP_ENERGY_PER_RADIATION;
    }

    diffuse(resource, duration) {
        const { width } = this;
        const ground = this[resource];
        const next = this.diffusionBuffers[resource];
        const fraction = DIFFUSION_RATES[resource] * duration;
        for (let row = 0; row < ground.length; row += width) {
            const end = row + width;
            const above = row === 0 ? ground.length - width : row - width;
            const below = end === ground.length ? 0 : end;
            let left = ground[end - 1];
            for (let index = row; index < end; index++) {
                const amount = ground[index];
                const right = ground[index + 1 === end ? row : index + 1];
                const column = index - row;
                const adjacent = left + right + ground[above + column] + ground[below + column];
                next[index] = amount + (adjacent - 4 * amount) * fraction;
                left = amount;
            }
        }
        this[resource] = next;
        this.diffusionBuffers[resource] = ground;
    }

    bite(cell) {
        const resource = TOOTH_RESOURCE[cell.type];
        const base = BITE_RATE * STEP * productionFactor(cell[resource], this.limits);
        const capacity = base + (resource === 'organic' ? organicBoost(cell, base) : 0);
        if (capacity === 0) {
            cell.lastWorkAge = cell.age;
            return;
        }
        for (const index of this.neighbors(cell.index)) {
            const target = this.cells.get(index);
            if (!target || target.colony.family === cell.colony.family || target[resource] <= 0) continue;
            const amount = Math.min(capacity, target[resource]);
            target[resource] -= amount;
            cell[resource] += amount;
            if (amount >= MIN_USEFUL_WORK) cell.lastWorkAge = cell.age;
            cell.energy -= Math.max(0, amount - base);
            break;
        }
    }

    isSeedSiteSafe(index) {
        return this.energy[index] < this.limits.soil && this.organic[index] < this.limits.soil
            && this.radiation[index] <= RADIATION_LETHAL_ABOVE;
    }

    throwSeed(cell) {
        const { throwEnergy, organic } = cell.colony.seedNeeds;
        if (cell.energy < throwEnergy || cell.organic < organic) return false;
        const columns = this.throwColumns[cell.index % this.width];
        const rows = this.throwRows[Math.floor(cell.index / this.width)];
        const start = Math.floor(this.random() * THROW_OFFSETS.length);
        if (this.cells.size === this.energy.length) return false;
        let offset = start;
        for (let i = 0; i < THROW_OFFSETS.length; i++) {
            const index = columns[offset] + rows[offset];
            if (++offset === THROW_OFFSETS.length) offset = 0;
            if (this.cells.has(index) || !this.isSeedSiteSafe(index)) continue;
            const nx = index % this.width;
            const ny = Math.floor(index / this.width);
            if (!this.seed(nx, ny, cell.colony, THROWN_SEED_COST)) continue;
            cell.energy -= THROWN_SEED_COST.energy;
            cell.organic -= THROWN_SEED_COST.organic;
            return true;
        }
        return false;
    }

    adaptiveCollector(index) {
        const x = index % this.width;
        const y = Math.floor(index / this.width);
        let energy = 0;
        let organic = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const site = this.wrappedIndex(x + dx, y + dy);
                energy += this.energy[site];
                organic += this.organic[site];
            }
        }
        return energy > organic ? 'energy' : 'organic';
    }

    radiationGrowthSite(candidates) {
        let site;
        let best = -1;
        for (const candidate of candidates) {
            if (this.cells.has(candidate) || !this.isSeedSiteSafe(candidate)) continue;
            const x = candidate % this.width;
            const y = Math.floor(candidate / this.width);
            let radiation = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    radiation += this.radiation[this.wrappedIndex(x + dx, y + dy)];
                }
            }
            if (radiation > best) {
                best = radiation;
                site = candidate;
            }
        }
        return site;
    }

    grow(cell) {
        if (cell.colony.thirsty) return;
        const { type, direction, preferBuild, branchStep, seekRadiation } = cell.colony.genome[cell.gene % cell.colony.genome.length];
        const neighbors = this.neighbors(cell.index);
        const cost = type === 'channel' ? CHANNEL_COST : CELL_COST;
        const requirements = type === 'seed' ? cell.colony.seedNeeds : cost;
        const ordered = neighbors.slice(direction).concat(neighbors.slice(0, direction));
        const biting = Boolean(TOOTH_RESOURCE[type]);
        const host = biting ? ordered.map(index => this.cells.get(index)).find(target =>
            target && target.colony.family !== cell.colony.family
            && !this.parasites.has(target.index) && this.isSeedSiteSafe(target.index)) : null;
        const index = host?.index ?? (seekRadiation ? this.radiationGrowthSite(ordered) : ordered.find(candidate => {
            if (this.cells.has(candidate)) return false;
            if (type === 'seed') return this.isSeedSiteSafe(candidate);
            if (!biting) return true;
            return this.neighbors(candidate).some(adjacent => {
                const neighbor = this.cells.get(adjacent);
                return neighbor && neighbor.colony.family !== cell.colony.family;
            });
        }));
        const buildFirst = (preferBuild || host) && index !== undefined
            && cell.energy >= requirements.energy && cell.organic >= requirements.organic;
        if (!buildFirst && this.throwSeed(cell)) {
            if (type === 'seed') cell.gene++;
            return;
        }
        if (index === undefined) {
            if (biting || seekRadiation) cell.gene++;
            return;
        }
        if (cell.energy < requirements.energy || cell.organic < requirements.organic) return;

        if (type === 'seed') {
            this.seed(index % this.width, Math.floor(index / this.width), cell.colony);
            cell.energy -= SEED_COST.energy;
            cell.organic -= SEED_COST.organic;
        } else {
            const childType = type === 'adaptive' ? this.adaptiveCollector(index) : type;
            const child = this.makeCell(index, childType, cell.colony, cost.energy, cost.organic);
            if (type === 'channel') child.gene = branchStep ?? cell.gene + 1;
            if (host) {
                child.host = host;
                this.parasites.set(index, child);
            } else {
                this.cells.set(index, child);
            }
            this.tickCells = null;
            this.onBirth?.(index);
            cell.energy -= cost.energy;
            cell.organic -= cost.organic;
        }
        cell.gene++;
    }

    recycleUnusedCells() {
        this.recycleCollection(this.cells);
        if (this.parasites.size) this.recycleCollection(this.parasites);
    }

    recycleCollection(collection) {
        for (const cell of collection.values()) {
            if (!RECYCLABLE_TYPES.has(cell.type) || cell.age - cell.lastWorkAge < IDLE_RECYCLE_AGE) continue;
            const channels = [];
            for (const index of this.neighbors(cell.index)) {
                const neighbor = this.cells.get(index);
                if (neighbor?.type === 'channel' && neighbor.colony.family === cell.colony.family) {
                    channels.push(neighbor);
                }
            }
            if (channels.length === 0) continue;
            const energy = cell.energy / channels.length;
            const organic = cell.organic / channels.length;
            for (const channel of channels) {
                channel.energy += energy;
                channel.organic += organic;
            }
            this.removeCell(cell);
        }
    }

    removeCell(cell) {
        this.tickCells = null;
        if (cell.host) {
            this.parasites.delete(cell.index);
            return;
        }
        this.cells.delete(cell.index);
        const parasite = this.parasites.get(cell.index);
        if (parasite) {
            this.parasites.delete(cell.index);
            parasite.host = null;
            this.cells.set(cell.index, parasite);
        }
    }

    drop(cell, cause, resources) {
        this.radiation[cell.index] += DEATH_RADIATION;
        this.energy[cell.index] += cell.energy;
        this.organic[cell.index] += cell.organic;
        this.removeCell(cell);
        this.onDeath?.(cell.index, cause, resources);
    }

    removeToxicCells() {
        this.removeToxicFrom(this.cells);
        if (this.parasites.size) this.removeToxicFrom(this.parasites);
    }

    removeToxicFrom(collection) {
        for (const cell of collection.values()) {
            const resources = resourceMask(
                this.energy[cell.index] >= this.limits.soil && cell.type !== 'energy',
                this.organic[cell.index] >= this.limits.soil && cell.type !== 'organic'
            ) | (this.radiation[cell.index] > RADIATION_LETHAL_ABOVE ? RADIATION_RESOURCE : 0);
            if (resources) this.drop(cell, 'excess', resources);
        }
    }

    prepareTick(daylight) {
        if (this.tickCells?.length === this.cells.size + this.parasites.size && this.tickDaylight === daylight) return;
        let grid = null;
        let existing;
        if (this.cells.size > this.energy.length / 4) {
            grid = new Array(this.energy.length);
            for (const cell of this.cells.values()) grid[cell.index] = cell;
            existing = daylight ? grid.filter(Boolean) : [...this.cells.values()];
        } else {
            existing = [...this.cells.values()];
            if (daylight) existing.sort((a, b) => a.index - b.index);
        }
        this.tickCells = existing;
        this.tickDaylight = daylight;
        this.transfers.length = 0;
        for (const cell of existing) {
            for (const index of this.neighbors(cell.index)) {
                if (index <= cell.index) continue;
                const neighbor = grid ? grid[index] : this.cells.get(index);
                if (!neighbor || neighbor.colony.family !== cell.colony.family) continue;
                this.transfers.push({ cell, neighbor, energy: 0, organic: 0 });
            }
        }
        for (const parasite of this.parasites.values()) {
            existing.push(parasite);
            for (const index of this.neighbors(parasite.index)) {
                const neighbor = this.cells.get(index);
                if (!neighbor || neighbor.colony.family !== parasite.colony.family) continue;
                this.transfers.push({ cell: parasite, neighbor, energy: 0, organic: 0 });
            }
        }
    }

    interceptResource(receiver, resource, amount) {
        const trap = !receiver.host && this.parasites.get(receiver.index);
        if (!trap || TOOTH_RESOURCE[trap.type] !== resource || this.overloaded.has(trap.colony)) return;
        const stolen = Math.min(amount, Math.max(0, this.limits.stop - trap[resource]));
        trap[resource] += stolen;
        receiver[resource] -= stolen;
        if (stolen >= MIN_USEFUL_WORK) trap.lastWorkAge = trap.age;
    }

    tick() {
        const tickNumber = Math.round(this.time / STEP) + 1;
        this.time = tickNumber * STEP;
        this.removeToxicCells();
        if (tickNumber % DIFFUSION_TICKS === 0) {
            const duration = STEP * DIFFUSION_TICKS;
            this.diffuse('energy', duration);
            this.diffuse('organic', duration);
            this.diffuse('radiation', duration);
        }
        this.removeToxicCells();
        if (this.cells.size === 0) {
            this.colonies.clear();
            this.transfers.length = 0;
            return;
        }
        const daylight = this.daylight;
        const needsColonyCleanup = this.tickCells === null;
        this.prepareTick(daylight);
        const existing = this.tickCells;
        for (const colony of this.colonies.values()) {
            colony.organicReserve = 0;
            colony.reserveCells = 0;
        }
        for (const cell of existing) {
            cell.colony.organicReserve += cell.organic;
            cell.colony.reserveCells++;
        }
        for (const colony of this.colonies.values()) {
            colony.thirsty = colony.organicReserve < ORGANIC_THIRST_THRESHOLD * colony.reserveCells;
        }
        const shadedColumns = this.shadedColumns;
        if (daylight) {
            shadedColumns.fill(0);
            // Sunlight comes from above the field.
            for (const cell of existing) {
                const x = cell.index % this.width;
                if (cell.type === 'chlorophyll') {
                    const lightRate = shadedColumns[x] ? 50 : 150;
                    cell.energy += lightRate * STEP * productionFactor(cell.energy, this.limits);
                }
                shadedColumns[x] = 1;
            }
        }

        for (const cell of existing) {
            cell.flow = 0;
            cell.flowResources = 0;
            cell.age += STEP;
            if (cell.type === 'seed' && cell.age >= 2) cell.type = 'channel';
            if (cell.type === 'organic' || cell.type === 'energy') this.collect(cell, cell.type);
            if (!daylight && cell.type === 'chlorophyll') {
                cell.energy += NIGHT_ENERGY_RATE * STEP * productionFactor(cell.energy, this.limits);
                cell.organic += NIGHT_ORGANIC_RATE * STEP * productionFactor(cell.organic, this.limits);
            }
        }

        for (const cell of existing) {
            if (TOOTH_RESOURCE[cell.type] && !cell.host) this.bite(cell);
        }

        // Compute transfers from the same snapshot so no cell spends incoming
        // resources until the following tick.
        const transfers = this.transfers;
        const parasites = this.parasites.size ? this.parasites : null;
        for (const transfer of transfers) {
            const { cell, neighbor } = transfer;
            if (cell.type !== 'channel' && neighbor.type !== 'channel') {
                transfer.energy = transfer.organic = 0;
                continue;
            }
            let sourceEnergy = cell.energy;
            let targetEnergy = neighbor.energy;
            let sourceOrganic = cell.organic;
            let targetOrganic = neighbor.organic;
            if (parasites) {
                const sourceTrap = !cell.host && parasites.get(cell.index);
                const targetTrap = !neighbor.host && parasites.get(neighbor.index);
                if (sourceTrap?.type === 'blueTeeth') sourceEnergy = Math.min(sourceEnergy, sourceTrap.energy);
                else if (sourceTrap) sourceOrganic = Math.min(sourceOrganic, sourceTrap.organic);
                if (targetTrap?.type === 'blueTeeth') targetEnergy = Math.min(targetEnergy, targetTrap.energy);
                else if (targetTrap) targetOrganic = Math.min(targetOrganic, targetTrap.organic);
            }
            const energy = (sourceEnergy - targetEnergy) * 0.025;
            const organic = (sourceOrganic - targetOrganic) * 0.025;
            const flow = (Math.abs(energy) + Math.abs(organic)) / STEP;
            transfer.energy = energy;
            transfer.organic = organic;
            cell.flow += flow;
            neighbor.flow += flow;
            const resources = resourceMask(energy, organic);
            cell.flowResources |= resources;
            neighbor.flowResources |= resources;
        }

        const overloaded = this.overloaded;
        overloaded.clear();
        for (const cell of existing) {
            if (cell.type === 'channel' && cell.flow > this.limits.flow) {
                overloaded.set(cell.colony, (overloaded.get(cell.colony) ?? 0) | cell.flowResources);
            }
        }
        this.overloads += overloaded.size;
        for (const { cell, neighbor, energy, organic } of transfers) {
            if (energy === 0 && organic === 0) continue;
            if (overloaded.size && (overloaded.has(cell.colony) || overloaded.has(neighbor.colony))) continue;
            if (parasites) {
                if (energy) this.interceptResource(energy > 0 ? neighbor : cell, 'energy', Math.abs(energy));
                if (organic) this.interceptResource(organic > 0 ? neighbor : cell, 'organic', Math.abs(organic));
            }
            cell.energy -= energy;
            neighbor.energy += energy;
            cell.organic -= organic;
            neighbor.organic += organic;
        }

        for (const cell of existing) {
            const excess = overloaded.size && overloaded.get(cell.colony);
            if (excess) {
                this.drop(cell, 'excess', excess);
                continue;
            }
            if (cell.type === 'converter' && cell.organic >= this.limits.stop) {
                cell.lastWorkAge = cell.age;
            } else if (cell.type === 'converter' && cell.energy > cell.organic) {
                const difference = cell.energy - cell.organic;
                const capacity = CONVERSION_RATE * STEP * productionFactor(cell.organic, this.limits);
                const base = Math.min(capacity, difference / 2);
                // Each bonus unit closes the gap by three: two energy spent, one organic gained.
                const bonus = Math.min(organicBoost(cell, capacity), Math.max(0, difference - 2 * base) / 3);
                cell.energy -= base + 2 * bonus;
                cell.organic += base + bonus;
                if (base + bonus >= MIN_USEFUL_WORK) cell.lastWorkAge = cell.age;
            } else if (cell.type === 'stomach' && (cell.colony.thirsty || cell.energy >= this.limits.stop)) {
                cell.lastWorkAge = cell.age;
            } else if (cell.type === 'stomach' && cell.organic > cell.energy) {
                const amount = Math.min(
                    CONVERSION_RATE * STEP * productionFactor(cell.energy, this.limits),
                    (cell.organic - cell.energy) / 2
                );
                cell.organic -= amount;
                cell.energy += amount;
                if (amount >= MIN_USEFUL_WORK) cell.lastWorkAge = cell.age;
            }
            if (cell.type === 'cleaner') this.cleanRadiation(cell);
            cell.energy = Math.max(0, cell.energy - ENERGY_UPKEEP * STEP);
            cell.organic = Math.max(0, cell.organic - ORGANIC_UPKEEP * STEP);
            const deficit = resourceMask(cell.energy === 0, cell.organic === 0);
            if (deficit) {
                this.drop(cell, 'deficit', deficit);
                continue;
            }
            if (cell.type === 'channel' && cell.age >= cell.growth) {
                cell.growth = cell.age + GROWTH_INTERVAL;
                this.grow(cell);
            }
        }
        this.removeToxicCells();
        if (tickNumber % RECYCLE_CHECK_TICKS === 0) this.recycleUnusedCells();
        if (needsColonyCleanup || this.tickCells === null) {
            const living = new Set();
            for (const cell of this.cells.values()) living.add(cell.colony.id);
            for (const cell of this.parasites.values()) living.add(cell.colony.id);
            for (const id of this.colonies.keys()) {
                if (!living.has(id)) this.colonies.delete(id);
            }
        }
    }
}
