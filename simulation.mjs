export const WIDTH = 100;
export const HEIGHT = 64;
export const STEP = 0.1;
export const SOIL_LIMIT = 5000;
export const TYPES = ['chlorophyll', 'organic', 'energy', 'channel', 'seed', 'converter', 'teeth'];
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const GROWTH_INTERVAL = 1.5;
const MUTATION_CHANCE = 0.02;
const CONVERSION_RATE = 50;
const BITE_RATE = 50;
const SEED_COST = 300;
const THROWN_SEED_COST = 900;
const THROW_OFFSETS = [];
for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance >= 2 && distance <= 3) THROW_OFFSETS.push([dx, dy]);
    }
}

export class Simulation {
    constructor(random = Math.random) {
        this.random = random;
        this.cells = new Map();
        this.colonies = new Map();
        this.energy = new Float64Array(WIDTH * HEIGHT);
        this.organic = Float64Array.from(this.energy, () => 350 + random() * 750);
        this.time = 0;
        this.totalSeeds = 0;
        this.mutations = 0;
        this.overloads = 0;
    }

    get daylight() {
        return this.time % 60 < 45;
    }

    seed(x, y, parent = null, reserve = parent ? SEED_COST : 1350) {
        const index = y * WIDTH + x;
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || this.cells.has(index)) return false;
        const id = ++this.totalSeeds;
        const genome = parent ? [...parent.genome] : [
            'chlorophyll', 'organic', 'channel',
            'seed', TYPES[Math.floor(this.random() * TYPES.length)]
        ];
        if (parent && this.random() < MUTATION_CHANCE) {
            const locus = Math.floor(this.random() * genome.length);
            const alternatives = TYPES.filter(type => type !== genome[locus]);
            genome[locus] = alternatives[Math.floor(this.random() * alternatives.length)];
            this.mutations++;
        }
        const colony = {
            id,
            hue: parent?.hue ?? (id * 137.508 + 25) % 360,
            family: parent?.family ?? id,
            genome,
            orientation: parent?.orientation ?? Math.floor(this.random() * 4)
        };
        this.colonies.set(id, colony);
        this.cells.set(index, this.makeCell(index, 'seed', colony, reserve));
        return true;
    }

    makeCell(index, type, colony, reserve) {
        return { index, type, colony, energy: reserve, organic: reserve, age: 0, growth: 0, gene: 0, flow: 0 };
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
        let remaining = 50 * STEP;
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
    }

    diffuse() {
        const next = new Float64Array(this.energy.length);
        for (let i = 0; i < this.energy.length; i++) {
            const amount = this.energy[i];
            if (!amount) continue;
            const share = amount * 0.06 * STEP;
            let retained = amount;
            for (const neighbor of this.neighbors(i)) {
                if (neighbor < 0) continue;
                next[neighbor] += share;
                retained -= share;
            }
            next[i] += retained;
        }
        this.energy = next;
    }

    bite(cell) {
        for (const index of this.neighbors(cell.index)) {
            const target = this.cells.get(index);
            if (!target || target.colony.family === cell.colony.family || target.organic <= 0) continue;
            const amount = Math.min(BITE_RATE * STEP, target.organic);
            target.organic -= amount;
            cell.organic += amount;
            break;
        }
    }

    throwSeed(cell) {
        if (cell.energy < THROWN_SEED_COST || cell.organic < THROWN_SEED_COST) return false;
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
            cell.organic -= THROWN_SEED_COST;
            return true;
        }
        return false;
    }

    grow(cell) {
        const type = cell.colony.genome[cell.gene % cell.colony.genome.length];
        if (type === 'seed' && this.throwSeed(cell)) {
            cell.gene++;
            return;
        }
        const neighbors = this.neighbors(cell.index);
        const cost = type === 'channel' ? 50 : SEED_COST;
        if (cell.energy < cost || cell.organic < cost) return;
        const rotation = (cell.colony.orientation + cell.gene) % 4;
        const ordered = neighbors.slice(rotation).concat(neighbors.slice(0, rotation));
        const index = ordered.find(candidate => candidate >= 0 && !this.cells.has(candidate));
        if (index === undefined) {
            if (type !== 'seed') this.throwSeed(cell);
            return;
        }

        if (type === 'seed') {
            this.seed(index % WIDTH, Math.floor(index / WIDTH), cell.colony);
        } else {
            const child = this.makeCell(index, type, cell.colony, cost);
            if (type === 'channel') child.gene = cell.gene + 1;
            this.cells.set(index, child);
        }
        cell.energy -= cost;
        cell.organic -= cost;
        cell.gene++;
    }

    drop(cell) {
        this.energy[cell.index] += cell.energy;
        this.organic[cell.index] += cell.organic;
        this.cells.delete(cell.index);
    }

    isToxic(cell) {
        return (this.energy[cell.index] > SOIL_LIMIT && cell.type !== 'energy')
            || (this.organic[cell.index] > SOIL_LIMIT && cell.type !== 'organic');
    }

    removeToxicCells() {
        for (const cell of this.cells.values()) {
            if (this.isToxic(cell)) this.drop(cell);
        }
    }

    tick() {
        this.time += STEP;
        this.removeToxicCells();
        this.diffuse();
        this.removeToxicCells();
        const existing = [...this.cells.values()];
        const shadedColumns = new Set();
        if (this.daylight) {
            // Sunlight comes from above the field.
            for (const cell of existing.sort((a, b) => a.index - b.index)) {
                const x = cell.index % WIDTH;
                if (cell.type === 'chlorophyll') {
                    cell.energy += (shadedColumns.has(x) ? 50 : 150) * STEP;
                }
                shadedColumns.add(x);
            }
        }

        for (const cell of existing) {
            cell.flow = 0;
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
            }
        }

        const overloaded = new Set(existing.filter(cell => cell.type === 'channel' && cell.flow > 1000)
            .map(cell => cell.colony));
        this.overloads += overloaded.size;
        for (const { cell, neighbor, energy, organic } of transfers) {
            if (overloaded.has(cell.colony) || overloaded.has(neighbor.colony)) continue;
            cell.energy -= energy;
            cell.organic -= organic;
            neighbor.energy += energy;
            neighbor.organic += organic;
        }

        for (const cell of existing) {
            if (overloaded.has(cell.colony)) {
                this.drop(cell);
                continue;
            }
            if (cell.type === 'converter' && cell.energy > cell.organic) {
                const amount = Math.min(CONVERSION_RATE * STEP, (cell.energy - cell.organic) / 2);
                cell.energy -= amount;
                cell.organic += amount;
            }
            cell.energy = Math.max(0, cell.energy - 5 * STEP);
            cell.organic = Math.max(0, cell.organic - 5 * STEP);
            if (cell.energy === 0 || cell.organic === 0) {
                this.drop(cell);
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
