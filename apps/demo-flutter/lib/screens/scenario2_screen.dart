import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/webrtc_service.dart';
import '../scenarios/large_file_handler.dart';

class Scenario2Screen extends StatelessWidget {
  const Scenario2Screen({super.key});

  @override
  Widget build(BuildContext context) {
    final handler = context.watch<WebRtcService>().largeFileHandler;
    return ChangeNotifierProvider.value(
      value: handler,
      child: const _Scenario2View(),
    );
  }
}

class _Scenario2View extends StatelessWidget {
  const _Scenario2View();

  @override
  Widget build(BuildContext context) {
    final h = context.watch<LargeFileHandler>();

    final pct = h.totalSize > 0 ? h.bytesReceived / h.totalSize : 0.0;
    final mbReceived = (h.bytesReceived / (1024 * 1024)).toStringAsFixed(1);
    final mbTotal = (h.totalSize / (1024 * 1024)).toStringAsFixed(0);

    return Scaffold(
      backgroundColor: const Color(0xFF0f0f23),
      appBar: AppBar(
        title: const Text('📦 500 MB Large File'),
        backgroundColor: const Color(0xFF161b22),
      ),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Transfer Progress',
                style: TextStyle(color: Color(0xFF8b949e), fontSize: 13)),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: LinearProgressIndicator(
                value: pct.toDouble(),
                minHeight: 20,
                backgroundColor: const Color(0xFF21262d),
                color: const Color(0xFF58a6ff),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '$mbReceived MB / $mbTotal MB (${(pct * 100).toStringAsFixed(1)}%)',
              style: const TextStyle(color: Color(0xFF8b949e), fontSize: 12),
            ),
            const SizedBox(height: 20),
            _StatRow(label: 'Speed', value: h.speedMBps != null
                ? '${h.speedMBps!.toStringAsFixed(2)} MB/s'
                : '—'),
            _StatRow(label: 'Elapsed', value: h.elapsedMs != null
                ? '${(h.elapsedMs! / 1000).toStringAsFixed(1)}s'
                : '—'),
            _StatRow(
              label: 'Verification',
              value: h.verified == null
                  ? '⏳ Receiving...'
                  : h.verified!
                      ? '✅ SHA-256 MATCH'
                      : '❌ SHA-256 MISMATCH',
              valueColor: h.verified == null
                  ? Colors.orange
                  : h.verified!
                      ? Colors.green
                      : Colors.red,
            ),
            const SizedBox(height: 16),
            const Text('Local SHA-256',
                style: TextStyle(color: Color(0xFF8b949e), fontSize: 12)),
            Text(
              h.sha256Local.isEmpty ? '—' : h.sha256Local,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
            const SizedBox(height: 8),
            const Text('Remote SHA-256',
                style: TextStyle(color: Color(0xFF8b949e), fontSize: 12)),
            Text(
              h.sha256Remote.isEmpty ? '—' : h.sha256Remote,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatRow extends StatelessWidget {
  final String label;
  final String value;
  final Color? valueColor;

  const _StatRow({required this.label, required this.value, this.valueColor});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Color(0xFF8b949e))),
          Text(value,
              style: TextStyle(
                  fontWeight: FontWeight.bold,
                  color: valueColor ?? const Color(0xFFe6edf3))),
        ],
      ),
    );
  }
}
