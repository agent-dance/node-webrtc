import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/signaling_service.dart';
import '../services/webrtc_service.dart';
import 'scenario1_screen.dart';
import 'scenario2_screen.dart';
import 'scenario3_screen.dart';
import 'scenario4_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final signaling = context.watch<SignalingService>();
    final webrtc = context.watch<WebRtcService>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('ts-rtc P2P Demo'),
        backgroundColor: const Color(0xFF161b22),
      ),
      backgroundColor: const Color(0xFF0f0f23),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _ConnectionBar(signaling: signaling, webrtc: webrtc),
            const SizedBox(height: 24),
            const Text(
              'Select a Scenario',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF58a6ff)),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: GridView.count(
                crossAxisCount: 2,
                crossAxisSpacing: 12,
                mainAxisSpacing: 12,
                children: [
                  _ScenarioCard(
                    emoji: '📁',
                    title: 'Multi-File Transfer',
                    description: '5 files in parallel\nSHA-256 verified',
                    onTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const Scenario1Screen())),
                  ),
                  _ScenarioCard(
                    emoji: '📦',
                    title: '500 MB Large File',
                    description: '256KB chunks\nSpeed > 10 MB/s',
                    onTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const Scenario2Screen())),
                  ),
                  _ScenarioCard(
                    emoji: '🐍',
                    title: 'Snake Game',
                    description: 'Node.js server\nReal-time input',
                    onTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const Scenario3Screen())),
                  ),
                  _ScenarioCard(
                    emoji: '🎥',
                    title: 'Video Stream',
                    description: '320×240 @30fps\nHSV animation',
                    onTap: () => Navigator.push(context,
                        MaterialPageRoute(builder: (_) => const Scenario4Screen())),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConnectionBar extends StatelessWidget {
  final SignalingService signaling;
  final WebRtcService webrtc;

  const _ConnectionBar({required this.signaling, required this.webrtc});

  @override
  Widget build(BuildContext context) {
    final isConnected = signaling.state == SignalingState.connected;
    final connState = webrtc.connectionState;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFF161b22),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFF30363d)),
      ),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _connColor(connState),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'WebRTC: ${connState.name}  •  Signaling: ${signaling.state.name}',
              style: const TextStyle(fontSize: 13),
            ),
          ),
          if (!isConnected)
            ElevatedButton(
              onPressed: () => signaling.connect(),
              child: const Text('Connect'),
            )
          else
            ElevatedButton(
              onPressed: () => signaling.disconnect(),
              style: ElevatedButton.styleFrom(backgroundColor: Colors.red.shade700),
              child: const Text('Disconnect'),
            ),
        ],
      ),
    );
  }

  Color _connColor(PeerConnectionState state) {
    switch (state) {
      case PeerConnectionState.connected:
        return Colors.green;
      case PeerConnectionState.connecting:
        return Colors.orange;
      case PeerConnectionState.failed:
        return Colors.red;
      default:
        return Colors.grey;
    }
  }
}

class _ScenarioCard extends StatelessWidget {
  final String emoji;
  final String title;
  final String description;
  final VoidCallback onTap;

  const _ScenarioCard({
    required this.emoji,
    required this.title,
    required this.description,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: const Color(0xFF161b22),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFF30363d)),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(emoji, style: const TextStyle(fontSize: 40)),
            const SizedBox(height: 8),
            Text(
              title,
              style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF58a6ff)),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 4),
            Text(
              description,
              style: const TextStyle(fontSize: 12, color: Color(0xFF8b949e)),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
