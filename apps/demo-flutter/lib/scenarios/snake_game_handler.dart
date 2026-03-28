import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

typedef Position = ({int x, int y});

enum Direction { up, down, left, right }

class SnakeBody {
  final String id;
  final List<Position> body;
  final Direction direction;
  final bool alive;
  const SnakeBody({
    required this.id,
    required this.body,
    required this.direction,
    required this.alive,
  });
}

class SnakeGameHandler extends ChangeNotifier {
  int tick = 0;
  List<SnakeBody> snakes = [];
  Position food = (x: 0, y: 0);
  Map<String, int> scores = {};
  bool gameOver = false;
  int? pingMs;
  int _lastTick = -1;

  RTCDataChannel? _channel;

  void handleChannel(RTCDataChannel channel) {
    _channel = channel;
    debugPrint('[Snake] Channel ready');

    channel.onMessage = (RTCDataChannelMessage message) {
      if (!message.isBinary) {
        _handleMessage(message.text);
      }
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      debugPrint('[Snake] State: $state');
    };

    // Start ping loop
    _startPing();
  }

  void _handleMessage(String text) {
    try {
      final msg = jsonDecode(text) as Map<String, dynamic>;
      final type = msg['type'] as String?;

      if (type == 'STATE') {
        final payload = msg['payload'] as Map<String, dynamic>;
        final newTick = payload['tick'] as int;

        // Discard stale frames
        if (newTick <= _lastTick) return;
        _lastTick = newTick;

        tick = newTick;
        final foodRaw = payload['food'] as Map<String, dynamic>;
        food = (x: foodRaw['x'] as int, y: foodRaw['y'] as int);

        final scoresRaw = payload['scores'] as Map<String, dynamic>;
        scores = scoresRaw.map((k, v) => MapEntry(k, v as int));

        gameOver = payload['gameOver'] as bool;

        final snakesRaw = payload['snakes'] as List<dynamic>;
        snakes = snakesRaw.map((s) {
          final sm = s as Map<String, dynamic>;
          final bodyRaw = sm['body'] as List<dynamic>;
          final body = bodyRaw.map((p) {
            final pm = p as Map<String, dynamic>;
            return (x: pm['x'] as int, y: pm['y'] as int);
          }).toList();
          return SnakeBody(
            id: sm['id'] as String,
            body: body,
            direction: _parseDirection(sm['direction'] as String),
            alive: sm['alive'] as bool,
          );
        }).toList();

        notifyListeners();
      } else if (type == 'PONG') {
        final payload = msg['payload'] as Map<String, dynamic>;
        final sentTs = payload['ts'] as int;
        pingMs = DateTime.now().millisecondsSinceEpoch - sentTs;
        notifyListeners();
      }
    } catch (e) {
      debugPrint('[Snake] Parse error: $e');
    }
  }

  void sendDirection(Direction dir) {
    final dirStr = dir.name.toUpperCase();
    _channel?.send(RTCDataChannelMessage(jsonEncode({
      'type': 'INPUT',
      'payload': {'direction': dirStr},
    })));
  }

  void _startPing() {
    Future.doWhile(() async {
      if (_channel == null) return false;
      await Future.delayed(const Duration(seconds: 1));
      if (_channel == null) return false;
      _channel!.send(RTCDataChannelMessage(jsonEncode({
        'type': 'PING',
        'payload': {'ts': DateTime.now().millisecondsSinceEpoch},
      })));
      return !gameOver;
    });
  }

  static Direction _parseDirection(String s) {
    switch (s) {
      case 'UP': return Direction.up;
      case 'DOWN': return Direction.down;
      case 'LEFT': return Direction.left;
      case 'RIGHT': return Direction.right;
      default: return Direction.right;
    }
  }
}
