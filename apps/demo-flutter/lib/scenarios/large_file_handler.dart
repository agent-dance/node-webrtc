import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class LargeFileHandler extends ChangeNotifier {
  int totalSize = 0;
  int bytesReceived = 0;
  bool? verified;
  String sha256Local = '';
  String sha256Remote = '';
  int? elapsedMs;
  double? speedMBps;

  late Uint8List _buffer;
  bool _ready = false;
  int _expectedChunkSize = 0;
  DateTime? _startTime;
  RTCDataChannel? _channel;

  void handleChannel(RTCDataChannel channel) {
    _channel = channel;
    debugPrint('[LargeFile] Channel ready');

    channel.onMessage = (RTCDataChannelMessage message) {
      debugPrint('[LargeFile] message isBinary=${message.isBinary} len=${message.isBinary ? message.binary.length : message.text.length}');
      if (message.isBinary) {
        _handleChunk(message.binary);
      } else {
        _handleText(message.text);
      }
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      debugPrint('[LargeFile] State: $state');
    };
  }

  void _handleText(String text) {
    try {
      final msg = jsonDecode(text) as Map<String, dynamic>;
      final type = msg['type'] as String?;
      debugPrint('[LargeFile] text message type=$type');

      if (type == 'LARGE_FILE_META') {
        final payload = msg['payload'] as Map<String, dynamic>;
        totalSize = payload['totalSize'] as int;
        _expectedChunkSize = payload['chunkSize'] as int;

        // Pre-allocate buffer
        _buffer = Uint8List(totalSize);
        bytesReceived = 0;
        verified = null;
        _ready = false;
        notifyListeners();

        debugPrint('[LargeFile] Meta received: totalSize=$totalSize');

        // Send READY
        _channel?.send(RTCDataChannelMessage(jsonEncode({'type': 'READY'})));
        _startTime = DateTime.now();
        _ready = true;
      } else if (type == 'EOF_MARKER') {
        final payload = msg['payload'] as Map<String, dynamic>;
        sha256Remote = payload['sha256'] as String;
        _finalizeVerification();
      }
    } catch (e) {
      debugPrint('[LargeFile] Text parse error: $e');
    }
  }

  void _handleChunk(Uint8List data) {
    if (!_ready || data.length < 4) return;

    final seq = ByteData.sublistView(data, 0, 4).getUint32(0, Endian.big);
    final chunkData = data.sublist(4);
    final offset = seq * _expectedChunkSize;

    if (offset + chunkData.length <= _buffer.length) {
      _buffer.setRange(offset, offset + chunkData.length, chunkData);
      final prevMB = bytesReceived ~/ (4 * 1024 * 1024);
      bytesReceived += chunkData.length;
      final newMB = bytesReceived ~/ (4 * 1024 * 1024);
      // Only notify once per 4 MB to avoid flooding Flutter's event loop with rebuilds
      if (newMB > prevMB) notifyListeners();
    }
  }

  void _finalizeVerification() {
    final endTime = DateTime.now();
    elapsedMs = endTime.difference(_startTime!).inMilliseconds;

    final digest = sha256.convert(_buffer);
    sha256Local = digest.toString();
    verified = sha256Local == sha256Remote;
    speedMBps = (totalSize / (1024 * 1024)) / (elapsedMs! / 1000);

    debugPrint('[LargeFile] Verification: ${verified! ? "✅ OK" : "❌ FAIL"}, '
        'speed=${speedMBps!.toStringAsFixed(2)} MB/s');

    _channel?.send(RTCDataChannelMessage(jsonEncode({
      'type': 'VERIFY_RESULT',
      'payload': {
        'sha256': sha256Local,
        'ok': verified,
        'elapsed_ms': elapsedMs,
      }
    })));

    notifyListeners();
  }
}
