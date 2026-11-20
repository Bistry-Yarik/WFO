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
export const TYPES = ['chlorophyll', 'organic', 'energy', 'channel', 'seed', 'converter', 'teeth', 'cleaner'];
const GENOME_LENGTH = 9;
export const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const GROWTH_INTERVAL = 1.5;
const MUTATION_CHANCE = 0.02;
const MAX_MUTATION_CHANCE = 0.5;
const DEATH_RADIATION = 300;
const MUTATION_RADIATION_DIVISOR = 1.5;
const CONVERSION_RATE = 150;
const RADIATION_CLEANUP_RATE = 50;
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

const DAY_LENGTH = 450;
const CYCLE_LENGTH = 600;
const DIFFUSION_TICKS = 5;
const DIFFUSION_RATES = { energy: 0.006, organic: 0.0002, radiation: 0.002 };
const BITE_RATE = 100;
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

function resourceMask(energy, organic) {
    return (energy ? ENERGY_RESOURCE : 0) | (organic ? ORGANIC_RESOURCE : 0);
}

export class Simulation {
    constructor(random = Math.random, onDeath = null, limits = DEFAULT_LIMITS, width = WIDTH) {
        this.random = random;
        this.onDeath = onDeath;
        this.limits = limits;
        this.width = width;
        this.height = Math.round(width * HEIGHT / WIDTH);
        this.cells = new Map();
        this.colonies = new Map();
        this.tickCells = null;
        this.tickDaylight = null;
        this.transfers = [];
        this.overloaded = new Map();
        this.shadedColumns = new Uint8Array(width);
        this.energy = new Float64Array(this.width * this.height);
        this.radiation = new Float64Array(this.energy.length);
        this.neighborCache = new Array(this.energy.length);
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

    seed(x, y, parent = null, cost = SEED_COST) {
        const index = y * this.width + x;
        if (x < 0 || x >= this.width || y < 0 || y >= this.height || this.cells.has(index)) return false;
        const id = ++this.totalSeeds;
        const genome = parent ? parent.genome.map(command => ({ ...command })) : randomGenome(this.random);
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
                const alternatives = TYPES.filter(type => type !== command.type);
                command.type = alternatives[Math.floor(this.random() * alternatives.length)];
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
        return true;
    }

    makeCell(index, type, colony, energy, organic = energy) {
        return { index, type, colony, energy, organic, age: 0, growth: 0, gene: 0, flow: 0, flowResources: 0 };
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
        cell.energy -= Math.max(0, bonus - remaining);
    }

    cleanRadiation(cell) {
        const x = cell.index % this.width;
        const y = Math.floor(cell.index / this.width);
        const available = cell.energy - 2 * ENERGY_UPKEEP * STEP;
        if (available <= 0) return;
        let strongest = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                strongest = Math.max(strongest, this.radiation[this.wrappedIndex(x + dx, y + dy)]);
            }
        }
        const rate = strongest >= STRONG_RADIATION ? RADIATION_CLEANUP_MAX_RATE : RADIATION_CLEANUP_RATE;
        const budget = Math.min(rate * STEP, available);
        let remaining = budget;
        for (let dy = -1; dy <= 1 && remaining > 0; dy++) {
            for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
                const index = this.wrappedIndex(x + dx, y + dy);
                const removed = Math.min(this.radiation[index], remaining);
                this.radiation[index] -= removed;
                remaining -= removed;
            }
        }
        cell.energy -= budget - remaining;
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
        const base = BITE_RATE * STEP * productionFactor(cell.organic, this.limits);
        const capacity = base + organicBoost(cell, base);
        if (capacity === 0) return;
        for (const index of this.neighbors(cell.index)) {
            const target = this.cells.get(index);
            if (!target || target.colony.family === cell.colony.family || target.organic <= 0) continue;
            const amount = Math.min(capacity, target.organic);
            target.organic -= amount;
            cell.organic += amount;
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
        const x = cell.index % this.width;
        const y = Math.floor(cell.index / this.width);
        const start = Math.floor(this.random() * THROW_OFFSETS.length);
        for (let i = 0; i < THROW_OFFSETS.length; i++) {
            const [dx, dy] = THROW_OFFSETS[(start + i) % THROW_OFFSETS.length];
            const index = this.wrappedIndex(x + dx, y + dy);
            const nx = index % this.width;
            const ny = Math.floor(index / this.width);
            if (!this.isSeedSiteSafe(index)) continue;
            if (!this.seed(nx, ny, cell.colony, THROWN_SEED_COST)) continue;
            cell.energy -= THROWN_SEED_COST.energy;
            cell.organic -= THROWN_SEED_COST.organic;
            return true;
        }
        return false;
    }

    grow(cell) {
        if (cell.colony.thirsty) return;
        const { type, direction } = cell.colony.genome[cell.gene % cell.colony.genome.length];
        if (this.throwSeed(cell)) {
            if (type === 'seed') cell.gene++;
            return;
        }
        const neighbors = this.neighbors(cell.index);
        const cost = type === 'channel' ? CHANNEL_COST : CELL_COST;
        const requirements = type === 'seed' ? cell.colony.seedNeeds : cost;
        const ordered = neighbors.slice(direction).concat(neighbors.slice(0, direction));
        const index = ordered.find(candidate => {
            if (this.cells.has(candidate)) return false;
            if (type !== 'teeth') return true;
            return this.neighbors(candidate).some(adjacent => {
                const neighbor = this.cells.get(adjacent);
                return neighbor && neighbor.colony.family !== cell.colony.family;
            });
        });
        if (index === undefined) {
            if (type === 'teeth') cell.gene++;
            return;
        }
        if (cell.energy < requirements.energy || cell.organic < requirements.organic) return;

        if (type === 'seed') {
            this.seed(index % this.width, Math.floor(index / this.width), cell.colony);
            cell.energy -= SEED_COST.energy;
            cell.organic -= SEED_COST.organic;
        } else {
            const child = this.makeCell(index, type, cell.colony, cost.energy, cost.organic);
            if (type === 'channel') child.gene = cell.gene + 1;
            this.cells.set(index, child);
            this.tickCells = null;
            cell.energy -= cost.energy;
            cell.organic -= cost.organic;
        }
        cell.gene++;
    }

    drop(cell, cause, resources) {
        this.radiation[cell.index] += DEATH_RADIATION;
        this.energy[cell.index] += cell.energy;
        this.organic[cell.index] += cell.organic;
        this.cells.delete(cell.index);
        this.tickCells = null;
        this.onDeath?.(cell.index, cause, resources);
    }

    removeToxicCells() {
        for (const cell of this.cells.values()) {
            const resources = resourceMask(
                this.energy[cell.index] >= this.limits.soil && cell.type !== 'energy',
                this.organic[cell.index] >= this.limits.soil && cell.type !== 'organic'
            ) | (this.radiation[cell.index] > RADIATION_LETHAL_ABOVE ? RADIATION_RESOURCE : 0);
            if (resources) this.drop(cell, 'excess', resources);
        }
    }

    prepareTick(daylight) {
        if (this.tickCells?.length === this.cells.size && this.tickDaylight === daylight) return;
        const existing = [...this.cells.values()];
        if (daylight) existing.sort((a, b) => a.index - b.index);
        this.tickCells = existing;
        this.tickDaylight = daylight;
        this.transfers.length = 0;
        for (const cell of existing) {
            for (const index of this.neighbors(cell.index)) {
                if (index <= cell.index) continue;
                const neighbor = this.cells.get(index);
                if (!neighbor || neighbor.colony.family !== cell.colony.family) continue;
                this.transfers.push({ cell, neighbor, energy: 0, organic: 0 });
            }
        }
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
        }

        for (const cell of existing) {
            if (cell.type === 'teeth') this.bite(cell);
        }

        // Compute transfers from the same snapshot so no cell spends incoming
        // resources until the following tick.
        const transfers = this.transfers;
        for (const transfer of transfers) {
            const { cell, neighbor } = transfer;
            if (cell.type !== 'channel' && neighbor.type !== 'channel') {
                transfer.energy = transfer.organic = 0;
                continue;
            }
            const energy = (cell.energy - neighbor.energy) * 0.025;
            const organic = (cell.organic - neighbor.organic) * 0.025;
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
            cell.energy -= energy;
            cell.organic -= organic;
            neighbor.energy += energy;
            neighbor.organic += organic;
        }

        for (const cell of existing) {
            const excess = overloaded.size && overloaded.get(cell.colony);
            if (excess) {
                this.drop(cell, 'excess', excess);
                continue;
            }
            if (cell.type === 'converter' && cell.energy > cell.organic) {
                const difference = cell.energy - cell.organic;
                const capacity = CONVERSION_RATE * STEP * productionFactor(cell.organic, this.limits);
                const base = Math.min(capacity, difference / 2);
                // Each bonus unit closes the gap by three: two energy spent, one organic gained.
                const bonus = Math.min(organicBoost(cell, capacity), Math.max(0, difference - 2 * base) / 3);
                cell.energy -= base + 2 * bonus;
                cell.organic += base + bonus;
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
        if (needsColonyCleanup || this.tickCells === null) {
            const living = new Set();
            for (const cell of this.cells.values()) living.add(cell.colony.id);
            for (const id of this.colonies.keys()) {
                if (!living.has(id)) this.colonies.delete(id);
            }
        }
    }
}
