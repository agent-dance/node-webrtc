import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/webrtc_service.dart';
import '../scenarios/file_transfer_handler.dart';

class Scenario1Screen extends StatelessWidget {
  const Scenario1Screen({super.key});

  @override
  Widget build(BuildContext context) {
    final handler = context.watch<WebRtcService>().fileTransferHandler;

    return ChangeNotifierProvider.value(
      value: handler,
      child: const _Scenario1View(),
    );
  }
}

class _Scenario1View extends StatelessWidget {
  const _Scenario1View();

  @override
  Widget build(BuildContext context) {
    final handler = context.watch<FileTransferHandler>();
    final files = handler.files;

    return Scaffold(
      backgroundColor: const Color(0xFF0f0f23),
      appBar: AppBar(
        title: const Text('📁 Multi-File Transfer'),
        backgroundColor: const Color(0xFF161b22),
      ),
      body: files.isEmpty
          ? const Center(
              child: Text(
                'Waiting for file transfers...\nMake sure Node.js is running and connected.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF8b949e)),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: files.length,
              itemBuilder: (ctx, i) {
                final f = files[i];
                final pct = f.size > 0 ? f.bytesReceived / f.size : 0.0;
                return Card(
                  color: const Color(0xFF161b22),
                  margin: const EdgeInsets.only(bottom: 12),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.insert_drive_file, color: Color(0xFF58a6ff)),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(f.name,
                                  style: const TextStyle(fontWeight: FontWeight.bold)),
                            ),
                            _VerifyBadge(verified: f.verified),
                          ],
                        ),
                        const SizedBox(height: 8),
                        LinearProgressIndicator(
                          value: pct.toDouble(),
                          backgroundColor: const Color(0xFF21262d),
                          color: const Color(0xFF58a6ff),
                        ),
                        const SizedBox(height: 4),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Text(
                              '${(f.bytesReceived / 1024).toStringAsFixed(1)} / '
                              '${(f.size / 1024).toStringAsFixed(1)} KB',
                              style: const TextStyle(fontSize: 12, color: Color(0xFF8b949e)),
                            ),
                            Text(
                              '${(pct * 100).toStringAsFixed(0)}%',
                              style: const TextStyle(fontSize: 12, color: Color(0xFF8b949e)),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
    );
  }
}

class _VerifyBadge extends StatelessWidget {
  final bool? verified;
  const _VerifyBadge({this.verified});

  @override
  Widget build(BuildContext context) {
    if (verified == null) {
      return const Text('⏳', style: TextStyle(fontSize: 18));
    } else if (verified!) {
      return const Text('✅', style: TextStyle(fontSize: 18));
    } else {
      return const Text('❌', style: TextStyle(fontSize: 18));
    }
  }
}
