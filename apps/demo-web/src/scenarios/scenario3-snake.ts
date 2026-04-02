import type { RTCPeerConnection } from '@agentdance/node-webrtc';
import type { RTCDataChannel } from '@agentdance/node-webrtc';
import type { AppStateManager, Direction, Position, SnakeState } from '../state/app-state.js';

const GRID_W = 20;
const GRID_H = 20;
const TICK_MS = 100; // 10 FPS

interface InputMessage {
  type: 'INPUT';
  payload: { direction: Direction };
}

interface PingMessage {
  type: 'PING';
  payload: { ts: number };
}

type ClientMessage = InputMessage | PingMessage;

interface StateMessage {
  type: 'STATE';
  payload: {
    tick: number;
    snakes: SnakeState[];
    food: Position;
    scores: Record<string, number>;
    gameOver: boolean;
  };
}

interface PongMessage {
  type: 'PONG';
  payload: { ts: number };
}

function randomPosition(): Position {
  return {
    x: Math.floor(Math.random() * GRID_W),
    y: Math.floor(Math.random() * GRID_H),
  };
}

function move(pos: Position, dir: Direction): Position {
  switch (dir) {
    case 'UP':
      return { x: pos.x, y: (pos.y - 1 + GRID_H) % GRID_H };
    case 'DOWN':
      return { x: pos.x, y: (pos.y + 1) % GRID_H };
    case 'LEFT':
      return { x: (pos.x - 1 + GRID_W) % GRID_W, y: pos.y };
    case 'RIGHT':
      return { x: (pos.x + 1) % GRID_W, y: pos.y };
  }
}

function posEq(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

class SnakeGame {
  private snakes: SnakeState[] = [
    {
      id: 'flutter',
      body: [
        { x: 5, y: 10 },
        { x: 4, y: 10 },
        { x: 3, y: 10 },
      ],
      direction: 'RIGHT',
      alive: true,
    },
  ];
  private food: Position = randomPosition();
  private tick = 0;
  private scores: Record<string, number> = { flutter: 0 };
  private gameOver = false;

  setDirection(snakeId: string, dir: Direction): void {
    const snake = this.snakes.find((s) => s.id === snakeId);
    if (snake && snake.alive) {
      // Prevent 180° reversal
      const opposite: Record<Direction, Direction> = {
        UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT',
      };
      if (dir !== opposite[snake.direction]) {
        snake.direction = dir;
      }
    }
  }

  step(): StateMessage['payload'] {
    this.tick++;

    for (const snake of this.snakes) {
      if (!snake.alive) continue;

      const newHead = move(snake.body[0]!, snake.direction);

      // Check wall collision (already wrapped via modulo above)
      // Check self collision
      if (snake.body.some((p) => posEq(p, newHead))) {
        snake.alive = false;
        continue;
      }

      snake.body.unshift(newHead);

      // Check food
      if (posEq(newHead, this.food)) {
        this.scores[snake.id] = (this.scores[snake.id] ?? 0) + 1;
        this.food = randomPosition();
      } else {
        snake.body.pop();
      }
    }

    if (this.snakes.every((s) => !s.alive)) {
      this.gameOver = true;
    }

    return {
      tick: this.tick,
      snakes: this.snakes.map((s) => ({ ...s, body: [...s.body] })),
      food: { ...this.food },
      scores: { ...this.scores },
      gameOver: this.gameOver,
    };
  }

  isOver(): boolean {
    return this.gameOver;
  }
}

export function registerScenario3Channel(
  pc: RTCPeerConnection,
  state: AppStateManager,
): void {
  const reliable =
    process.env.DEMO_SCENARIO3_RELIABLE === '1' ||
    process.env.DEMO_SCENARIO3_RELIABLE?.toLowerCase() === 'true';
  const channelInit = reliable
    ? { ordered: true }
    : { ordered: true, maxRetransmits: 0 };
  const channel: RTCDataChannel = pc.createDataChannel('snake-game', channelInit);

  const game = new SnakeGame();
  let tickTimer: NodeJS.Timeout | null = null;

  channel.on('open', () => {
    console.log('[Scenario3] Snake channel open, starting game loop');

    tickTimer = setInterval(() => {
      const gameState = game.step();

      const msg: StateMessage = {
        type: 'STATE',
        payload: gameState,
      };
      channel.send(JSON.stringify(msg));

      state.updateScenario3(gameState);

      if (gameState.gameOver && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
        console.log('[Scenario3] Game over');
      }
    }, TICK_MS);
  });

  channel.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString()) as ClientMessage;

      if (msg.type === 'INPUT') {
        game.setDirection('flutter', msg.payload.direction);
      } else if (msg.type === 'PING') {
        const pong: PongMessage = { type: 'PONG', payload: { ts: msg.payload.ts } };
        channel.send(JSON.stringify(pong));
      }
    } catch {
      // ignore
    }
  });

  channel.on('close', () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  });

  channel.on('error', (err) => {
    console.error('[Scenario3] Error:', err);
  });
}
