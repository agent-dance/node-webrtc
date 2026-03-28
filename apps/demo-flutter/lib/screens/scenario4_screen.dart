import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/webrtc_service.dart';
import '../scenarios/video_receiver_handler.dart';

class Scenario4Screen extends StatelessWidget {
  const Scenario4Screen({super.key});

  @override
  Widget build(BuildContext context) {
    final handler = context.watch<WebRtcService>().videoReceiverHandler;
    return ChangeNotifierProvider.value(
      value: handler,
      child: const _Scenario4View(),
    );
  }
}

class _Scenario4View extends StatelessWidget {
  const _Scenario4View();

  @override
  Widget build(BuildContext context) {
    final h = context.watch<VideoReceiverHandler>();

    return Scaffold(
      backgroundColor: const Color(0xFF0f0f23),
      appBar: AppBar(
        title: const Text('🎥 Video Stream'),
        backgroundColor: const Color(0xFF161b22),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _Chip('FPS', h.fps.toString()),
                _Chip('Received', h.framesReceived.toString()),
                _Chip('Dropped', h.framesDropped.toString()),
                _Chip('Drop%',
                    h.framesReceived + h.framesDropped > 0
                        ? '${(h.framesDropped / (h.framesReceived + h.framesDropped) * 100).toStringAsFixed(1)}%'
                        : '—'),
              ],
            ),
          ),
          Expanded(
            child: Center(
              child: AspectRatio(
                aspectRatio: 320 / 240,
                child: ValueListenableBuilder<ui.Image?>(
                  valueListenable: h.currentFrame,
                  builder: (ctx, image, _) {
                    if (image == null) {
                      return const Center(
                        child: Text(
                          'Waiting for video stream...',
                          style: TextStyle(color: Color(0xFF8b949e)),
                        ),
                      );
                    }
                    return CustomPaint(
                      painter: _ImagePainter(image),
                    );
                  },
                ),
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text(
              'Target: 30 FPS · 320×240 RGBA · HSV animation\n'
              'Drop threshold: buffered > 2 frames',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0xFF8b949e), fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _ImagePainter extends CustomPainter {
  final ui.Image image;
  _ImagePainter(this.image);

  @override
  void paint(Canvas canvas, Size size) {
    final src = Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble());
    final dst = Rect.fromLTWH(0, 0, size.width, size.height);
    canvas.drawImageRect(image, src, dst, Paint());
  }

  @override
  bool shouldRepaint(covariant _ImagePainter old) => old.image != image;
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
