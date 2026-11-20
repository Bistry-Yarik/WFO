export const WIDTH = 100;
export const HEIGHT = 64;
export const STEP = 0.1;
export const SOIL_LIMIT = 5000;
export const CHANNEL_FLOW_LIMIT = 2500;
export const ENERGY_RESOURCE = 1;
export const ORGANIC_RESOURCE = 2;
export const TYPES = ['chlorophyll', 'organic', 'energy', 'channel', 'seed', 'converter', 'teeth'];
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const GROWTH_INTERVAL = 1.5;
const MUTATION_CHANCE = 0.02;
const MAX_MUTATION_CHANCE = 0.5;
const DEATH_RADIATION = 300;
const SEED_ORGANIC_DIVISOR = 3;
const CONVERSION_RATE = 150;
const ENERGY_UPKEEP = 5;
const ORGANIC_UPKEEP = 2;
const BOOST_START = 900;
const BOOST_FULL = 1400;
const PRODUCTION_SLOWDOWN = 1000;
const PRODUCTION_STOP = 1500;

function productionFactor(stock) {
    return Math.max(0, Math.min(1, (PRODUCTION_STOP - stock) / (PRODUCTION_STOP - PRODUCTION_SLOWDOWN)));
}
function boostFactor(energy) {
    return Math.max(0, Math.min(1, (energy - BOOST_START) / (BOOST_FULL - BOOST_START)));
}

const DAY_LENGTH = 450;
const CYCLE_LENGTH = 600;
const SLOW_DIFFUSION_TICKS = 5;
const DIFFUSION_RATES = { energy: 0.006, organic: 0.0002, radiation: 0.002 };
const BITE_RATE = 50;
const SEED_COST = 300;
const THROWN_SEED_COST = 900;
const THROW_OFFSETS = [];
for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance >= 1 && distance <= 3) THROW_OFFSETS.push([dx, dy]);
    }
}

function resourceMask(energy, organic) {
    return (energy ? ENERGY_RESOURCE : 0) | (organic ? ORGANIC_RESOURCE : 0);
}

export class Simulation {
    constructor(random = Math.random, onDeath = null) {
        this.random = random;
        this.onDeath = onDeath;
        this.cells = new Map();
        this.colonies = new Map();
        this.energy = new Float64Array(WIDTH * HEIGHT);
        this.radiation = new Float64Array(this.energy.length);
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

    seed(x, y, parent = null, reserve = parent ? SEED_COST : 1350) {
        const index = y * WIDTH + x;
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || this.cells.has(index)) return false;
        const id = ++this.totalSeeds;
        const genome = parent ? [...parent.genome] : [
            'chlorophyll', 'organic', 'channel',
            'seed', TYPES[Math.floor(this.random() * TYPES.length)]
        ];
        const exposure = Math.min(this.radiation[index] / SOIL_LIMIT, 1);
        const mutationChance = MUTATION_CHANCE + exposure * (MAX_MUTATION_CHANCE - MUTATION_CHANCE);
        if (parent && this.random() < mutationChance) {
            const locus = Math.floor(this.random() * genome.length);
            const alternatives = TYPES.filter(type => type !== genome[locus]);
            genome[locus] = alternatives[Math.floor(this.random() * alternatives.length)];
            this.mutations++;
            for (let ny = Math.max(0, y - 1); ny <= Math.min(HEIGHT - 1, y + 1); ny++) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(WIDTH - 1, x + 1); nx++) {
                    this.radiation[ny * WIDTH + nx] /= 2;
                }
            }
        }
        const colony = {
            id,
            hue: parent?.hue ?? (id * 137.508 + 25) % 360,
            family: parent?.family ?? id,
            genome,
            orientation: parent?.orientation ?? Math.floor(this.random() * 4)
        };
        this.colonies.set(id, colony);
        const seed = this.makeCell(index, 'seed', colony, reserve);
        if (parent) seed.organic /= SEED_ORGANIC_DIVISOR;
        this.cells.set(index, seed);
        return true;
    }

    makeCell(index, type, colony, reserve) {
        return { index, type, colony, energy: reserve, organic: reserve, age: 0, growth: 0, gene: 0, flow: 0, flowResources: 0 };
    }

    neighbors(index) {
        const x = index % WIDTH;
        const y = Math.floor(index / WIDTH);
        return DIRECTIONS.map(([dx, dy]) => {
            const nx = x + dx;
            const ny = y + dy;
            return nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT ? ny * WIDTH + nx : -1;
        });
    }

    collect(cell, resource) {
        const ground = this[resource];
        const x = cell.index % WIDTH;
        const y = Math.floor(cell.index / WIDTH);
        const base = 50 * STEP * productionFactor(cell[resource]);
        const bonus = resource === 'organic' ? base * boostFactor(cell.energy) : 0;
        let remaining = base + bonus;
        for (let dy = -1; dy <= 1 && remaining > 0; dy++) {
            for (let dx = -1; dx <= 1 && remaining > 0; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
                const index = ny * WIDTH + nx;
                const amount = Math.min(remaining, ground[index]);
                ground[index] -= amount;
                cell[resource] += amount;
                remaining -= amount;
            }
        }
        cell.energy -= Math.max(0, bonus - remaining);
    }

    diffuse(resource, duration) {
        const ground = this[resource];
        const next = this.diffusionBuffers[resource];
        const fraction = DIFFUSION_RATES[resource] * duration;
        next.fill(0);
        for (let i = 0; i < ground.length; i++) {
            const amount = ground[i];
            if (!amount) continue;
            const share = amount * fraction;
            const x = i % WIDTH;
            let neighbors = 0;
            if (x > 0) {
                next[i - 1] += share;
                neighbors++;
            }
            if (x < WIDTH - 1) {
                next[i + 1] += share;
                neighbors++;
            }
            if (i >= WIDTH) {
                next[i - WIDTH] += share;
                neighbors++;
            }
            if (i < ground.length - WIDTH) {
                next[i + WIDTH] += share;
                neighbors++;
            }
            next[i] += amount - share * neighbors;
        }
        this[resource] = next;
        this.diffusionBuffers[resource] = ground;
    }

    bite(cell) {
        const base = BITE_RATE * STEP * productionFactor(cell.organic);
        const capacity = base * (1 + boostFactor(cell.energy));
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

    throwSeed(cell) {
        const organicCost = THROWN_SEED_COST / SEED_ORGANIC_DIVISOR;
        if (cell.energy < THROWN_SEED_COST || cell.organic < organicCost) return false;
        const x = cell.index % WIDTH;
        const y = Math.floor(cell.index / WIDTH);
        const start = Math.floor(this.random() * THROW_OFFSETS.length);
        for (let i = 0; i < THROW_OFFSETS.length; i++) {
            const [dx, dy] = THROW_OFFSETS[(start + i) % THROW_OFFSETS.length];
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
            const index = ny * WIDTH + nx;
            if (this.energy[index] > SOIL_LIMIT || this.organic[index] > SOIL_LIMIT) continue;
            if (!this.seed(nx, ny, cell.colony, THROWN_SEED_COST)) continue;
            cell.energy -= THROWN_SEED_COST;
            cell.organic -= organicCost;
            return true;
        }
        return false;
    }

    grow(cell) {
        const type = cell.colony.genome[cell.gene % cell.colony.genome.length];
        if (this.throwSeed(cell)) {
            if (type === 'seed') cell.gene++;
            return;
        }
        const neighbors = this.neighbors(cell.index);
        const cost = type === 'channel' ? 50 : SEED_COST;
        const organicCost = type === 'seed' ? cost / SEED_ORGANIC_DIVISOR : cost;
        if (cell.energy < cost || cell.organic < organicCost) return;
        const rotation = (cell.colony.orientation + cell.gene) % 4;
        const ordered = neighbors.slice(rotation).concat(neighbors.slice(0, rotation));
        const index = ordered.find(candidate => candidate >= 0 && !this.cells.has(candidate));
        if (index === undefined) return;

        if (type === 'seed') {
            this.seed(index % WIDTH, Math.floor(index / WIDTH), cell.colony);
        } else {
            const child = this.makeCell(index, type, cell.colony, cost);
            if (type === 'channel') child.gene = cell.gene + 1;
            this.cells.set(index, child);
        }
        cell.energy -= cost;
        cell.organic -= organicCost;
        cell.gene++;
    }

    drop(cell, cause, resources) {
        this.radiation[cell.index] += DEATH_RADIATION;
        this.energy[cell.index] += cell.energy;
        this.organic[cell.index] += cell.organic;
        this.cells.delete(cell.index);
        this.onDeath?.(cell.index, cause, resources);
    }

    removeToxicCells() {
        for (const cell of this.cells.values()) {
            const resources = resourceMask(
                this.energy[cell.index] > SOIL_LIMIT && cell.type !== 'energy',
                this.organic[cell.index] > SOIL_LIMIT && cell.type !== 'organic'
            );
            if (resources) this.drop(cell, 'excess', resources);
        }
    }

    tick() {
        const tickNumber = Math.round(this.time / STEP) + 1;
        this.time = tickNumber * STEP;
        this.removeToxicCells();
        this.diffuse('energy', STEP);
        if (tickNumber % SLOW_DIFFUSION_TICKS === 0) {
            const duration = STEP * SLOW_DIFFUSION_TICKS;
            this.diffuse('organic', duration);
            this.diffuse('radiation', duration);
        }
        this.removeToxicCells();
        const existing = [...this.cells.values()];
        const shadedColumns = new Set();
        if (this.daylight) {
            // Sunlight comes from above the field.
            for (const cell of existing.sort((a, b) => a.index - b.index)) {
                const x = cell.index % WIDTH;
                if (cell.type === 'chlorophyll') {
                    const lightRate = shadedColumns.has(x) ? 50 : 150;
                    cell.energy += lightRate * STEP * productionFactor(cell.energy);
                }
                shadedColumns.add(x);
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
        const transfers = [];
        for (const cell of existing) {
            for (const index of this.neighbors(cell.index)) {
                if (index <= cell.index) continue;
                const neighbor = this.cells.get(index);
                if (!neighbor || neighbor.colony.family !== cell.colony.family) continue;
                if (cell.type !== 'channel' && neighbor.type !== 'channel') continue;
                const energy = (cell.energy - neighbor.energy) * 0.025;
                const organic = (cell.organic - neighbor.organic) * 0.025;
                const flow = (Math.abs(energy) + Math.abs(organic)) / STEP;
                transfers.push({ cell, neighbor, energy, organic });
                cell.flow += flow;
                neighbor.flow += flow;
                const resources = resourceMask(energy, organic);
                cell.flowResources |= resources;
                neighbor.flowResources |= resources;
            }
        }

        const overloaded = new Map();
        for (const cell of existing) {
            if (cell.type === 'channel' && cell.flow > CHANNEL_FLOW_LIMIT) {
                overloaded.set(cell.colony, (overloaded.get(cell.colony) ?? 0) | cell.flowResources);
            }
        }
        this.overloads += overloaded.size;
        for (const { cell, neighbor, energy, organic } of transfers) {
            if (overloaded.has(cell.colony) || overloaded.has(neighbor.colony)) continue;
            cell.energy -= energy;
            cell.organic -= organic;
            neighbor.energy += energy;
            neighbor.organic += organic;
        }

        for (const cell of existing) {
            const excess = overloaded.get(cell.colony);
            if (excess) {
                this.drop(cell, 'excess', excess);
                continue;
            }
            if (cell.type === 'converter' && cell.energy > cell.organic) {
                const difference = cell.energy - cell.organic;
                const capacity = CONVERSION_RATE * STEP * productionFactor(cell.organic);
                const base = Math.min(capacity, difference / 2);
                // Each bonus unit closes the gap by three: two energy spent, one organic gained.
                const bonus = Math.min(capacity * boostFactor(cell.energy), Math.max(0, difference - 2 * base) / 3);
                cell.energy -= base + 2 * bonus;
                cell.organic += base + bonus;
            }
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
        const living = new Set([...this.cells.values()].map(cell => cell.colony.id));
        for (const id of this.colonies.keys()) {
            if (!living.has(id)) this.colonies.delete(id);
        }
    }
}
