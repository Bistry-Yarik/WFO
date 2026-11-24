import { algaeAIWeights } from './algae-ai-weights.mjs';

const { features, hidden, topics, parameters } = algaeAIWeights;
let weights;

function textFeatures(text) {
    const vector = new Float32Array(features);
    const add = fragment => {
        let hash = 5381;
        for (let i = 0; i < fragment.length; i++) hash = (Math.imul(hash, 33) ^ fragment.charCodeAt(i)) >>> 0;
        vector[hash % features]++;
    };
    for (const word of text.toLowerCase().replaceAll('ё', 'е').match(/[a-zа-я0-9]+/g) ?? []) {
        const chars = '^' + word + '$';
        add(chars);
        for (let size = 2; size <= 3; size++) {
            for (let i = 0; i + size <= chars.length; i++) add(chars.slice(i, i + size));
        }
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude) for (let i = 0; i < features; i++) vector[i] /= magnitude;
    return vector;
}

export function inferAlgaeTopic(text, previousTopic) {
    weights ??= parameters.map(({ bytes, scale }) =>
        Float32Array.from(atob(bytes), character => ((character.charCodeAt(0) << 24) >> 24) * scale));
    const [input, inputBias, output, outputBias] = weights;
    const vector = textFeatures(text);
    const layer = inputBias.slice();
    for (let i = 0; i < vector.length; i++) {
        if (!vector[i]) continue;
        for (let j = 0; j < hidden; j++) layer[j] += vector[i] * input[i * hidden + j];
    }
    const scores = outputBias.slice();
    for (let i = 0; i < hidden; i++) {
        const value = Math.tanh(layer[i]);
        for (let j = 0; j < scores.length; j++) scores[j] += value * output[i * scores.length + j];
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    const confidence = 1 / scores.reduce((sum, score) => sum + Math.exp(score - scores[best]), 0);
    if (confidence >= .53) return topics[best];
    if (previousTopic && previousTopic !== 'unknown' && text.trim().split(/\s+/).length <= 3) return previousTopic;
    return 'unknown';
}

export function answerAlgae(text, context, previousTopic) {
    const topic = inferAlgaeTopic(text, previousTopic);
    const { size, types, selectedCell, water3x3, neighbors, borderAlarm, daylight } = context;
    const count = types.chlorophyll ?? 0;
    const { energy, organic } = selectedCell;
    const { radiationMax, energyTotal, organicTotal } = water3x3;
    let reply;
    switch (topic) {
        case 'greeting':
            reply = borderAlarm ? 'Привет! Мы следим за беспокойной границей.' : 'Привет! У нас пока спокойно. О чём поговорим?';
            break;
        case 'identity':
            reply = `Я водоросль рода №${context.family}. В нашем роду сейчас ${size} клеток.`;
            break;
        case 'size':
            reply = `В нашем роду клеток: ${size}. Каналов: ${types.channel ?? 0}, семечек: ${types.seed ?? 0}.`;
            break;
        case 'radiation': {
            const status = radiationMax > context.radiationKillsAbove ? 'Часть воды здесь смертельна.'
                : radiationMax >= 150 ? 'Здесь очистители смогут добывать ресурсы из радиации.' : 'Высокого фона рядом не вижу.';
            reply = `${status} Максимум в воде вокруг этой клетки — ${radiationMax} рад.`;
            break;
        }
        case 'water':
            reply = `В квадрате 3×3 вокруг этой клетки всего ${energyTotal} энергии и ${organicTotal} органики. ${energyTotal > organicTotal ? 'Энергии больше.' : energyTotal < organicTotal ? 'Органики больше.' : 'Запасы одинаковы.'}`;
            break;
        case 'energy':
            reply = `В этой клетке ${energy} энергии. ${count ? `По колонии работают клетки с хлорофиллом: ${count}.` : 'У нас пока нет клеток с хлорофиллом.'}`;
            break;
        case 'organic':
            reply = `В этой клетке ${organic} органики, а в окружающей воде 3×3 — ${organicTotal}.`;
            break;
        case 'neighbors':
            reply = neighbors.length ? `Рядом вижу ${neighbors.map(({ family, size }) => size === null ? `род №${family}` : `род №${family} (${size} кл.)`).join(', ')}.`
                : borderAlarm ? 'От нашей границы недавно пришёл сигнал тревоги. Рядом с этой клеткой чужих родов не вижу.'
                : 'В пределах 3×3 от этой клетки чужих родов не видно.';
            break;
        case 'chlorophyll':
            reply = count ? `Спасибо за совет. У нас уже есть хлорофилл в ${count} кл. Он даёт энергию даже ночью.`
                : 'Хлорофилл пригодился бы: сейчас у нас нет ни одной такой клетки, а он даёт энергию даже ночью.';
            break;
        case 'growth':
            reply = borderAlarm ? 'У границы сильный сосед, поэтому ищем путь в обход.'
                : radiationMax >= 1000 ? 'С этой стороны опасная вода. Стоит расти мимо неё.'
                    : `Пока оцениваем соседние участки. Здесь в воде больше ${energyTotal > organicTotal ? 'энергии' : 'органики'}.`;
            break;
        case 'light':
            reply = `Сейчас ${daylight ? 'день' : 'ночь'}. Хлорофилл работает в обоих случаях, а ночью ещё и даёт немного органики.`;
            break;
        case 'trade':
            reply = 'Назови, что отдаёшь первым, и что хочешь получить. Например: «Обменяю 200 энергии на 100 органики».';
            break;
        case 'attack_offer':
            reply = 'Укажи номер рода и точную плату, например: «Атакуй род 2 за 300 органики».';
            break;
        case 'peace':
            reply = borderAlarm ? 'Мы заметили движение у границы. Можем держаться подальше, но договоров в игре пока нет.'
                : 'Пока у нас спокойно. Договоры между родами игра пока не умеет заключать.';
            break;
        default:
            reply = 'Не понял вопрос. Попробуй спросить про нашу границу, запасы воды или то, куда мы растём.';
    }
    return { topic, reply };
}
