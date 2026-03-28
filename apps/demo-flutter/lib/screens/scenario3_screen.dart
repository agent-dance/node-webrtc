import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/webrtc_service.dart';
import '../scenarios/snake_game_handler.dart';

const _gridSize = 20;

class Scenario3Screen extends StatelessWidget {
  const Scenario3Screen({super.key});

  @override
  Widget build(BuildContext context) {
    final handler = context.watch<WebRtcService>().snakeGameHandler;
    return ChangeNotifierProvider.value(
      value: handler,
      child: const _Scenario3View(),
    );
  }
}

class _Scenario3View extends StatelessWidget {
  const _Scenario3View();

  @override
  Widget build(BuildContext context) {
    final h = context.watch<SnakeGameHandler>();

    return Scaffold(
      backgroundColor: const Color(0xFF0f0f23),
      appBar: AppBar(
        title: const Text('🐍 Snake Game'),
        backgroundColor: const Color(0xFF161b22),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _Chip('Tick', h.tick.toString()),
                _Chip('Score', h.scores['flutter']?.toString() ?? '0'),
                _Chip('Ping', h.pingMs != null ? '${h.pingMs}ms' : '—'),
                _Chip('Status', h.gameOver ? 'Game Over' : h.tick > 0 ? 'Playing' : 'Waiting'),
              ],
            ),
          ),
          Expanded(
            child: Center(
              child: AspectRatio(
                aspectRatio: 1,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: CustomPaint(
                    painter: _SnakePainter(h),
                  ),
                ),
              ),
            ),
          ),
          // D-pad controls
          Padding(
            padding: const EdgeInsets.all(16),
            child: _DPad(handler: h),
          ),
        ],
      ),
    );
  }
}

class _SnakePainter extends CustomPainter {
  final SnakeGameHandler handler;
  _SnakePainter(this.handler) : super(repaint: handler);

  @override
  void paint(Canvas canvas, Size size) {
    final cellW = size.width / _gridSize;
    final cellH = size.height / _gridSize;

    // Background grid
    final gridPaint = Paint()
      ..color = const Color(0xFF1c2128)
      ..strokeWidth = 0.5
      ..style = PaintingStyle.stroke;

    for (int i = 0; i <= _gridSize; i++) {
      canvas.drawLine(
          Offset(i * cellW, 0), Offset(i * cellW, size.height), gridPaint);
      canvas.drawLine(
          Offset(0, i * cellH), Offset(size.width, i * cellH), gridPaint);
    }

    // Food
    final foodPaint = Paint()..color = Colors.red;
    final food = handler.food;
    canvas.drawRect(
        Rect.fromLTWH(food.x * cellW + 2, food.y * cellH + 2, cellW - 4, cellH - 4),
        foodPaint);

    // Snakes
    final colors = [Colors.green.shade400, Colors.blue.shade400, Colors.orange.shade400];
    for (int si = 0; si < handler.snakes.length; si++) {
      final snake = handler.snakes[si];
      final color = snake.alive ? colors[si % colors.length] : Colors.grey;
      for (int pi = 0; pi < snake.body.length; pi++) {
        final p = snake.body[pi];
        final alpha = pi == 0 ? 1.0 : (1.0 - pi * 0.04).clamp(0.2, 1.0);
        canvas.drawRect(
          Rect.fromLTWH(p.x * cellW + 1, p.y * cellH + 1, cellW - 2, cellH - 2),
          Paint()..color = color.withAlpha((alpha * 255).toInt()),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _SnakePainter old) => true;
}

class _DPad extends StatelessWidget {
  final SnakeGameHandler handler;
  const _DPad({required this.handler});

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _DPadButton(Icons.keyboard_arrow_up, () => handler.sendDirection(Direction.up)),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _DPadButton(Icons.keyboard_arrow_left, () => handler.sendDirection(Direction.left)),
            const SizedBox(width: 48),
            _DPadButton(Icons.keyboard_arrow_right, () => handler.sendDirection(Direction.right)),
          ],
        ),
        _DPadButton(Icons.keyboard_arrow_down, () => handler.sendDirection(Direction.down)),
      ],
    );
  }
}

class _DPadButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onPressed;
  const _DPadButton(this.icon, this.onPressed);

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 36),
      onPressed: onPressed,
      style: IconButton.styleFrom(
        backgroundColor: const Color(0xFF21262d),
        padding: const EdgeInsets.all(12),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final String value;
  const _Chip(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(label, style: const TextStyle(color: Color(0xFF8b949e), fontSize: 11)),
        const SizedBox(height: 2),
        Text(value,
            style: const TextStyle(
                fontWeight: FontWeight.bold, color: Color(0xFF58a6ff), fontSize: 13)),
      ],
    );
  }
}
