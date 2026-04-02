import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class FileInfo {
  final String id;
  final String name;
  final int size;
  final String sha256;
  final int generatorIndex;
  final String transportMode;
  int bytesReceived;
  bool? verified;
  Uint8List? data;

  FileInfo({
    required this.id,
    required this.name,
    required this.size,
    required this.sha256,
    required this.generatorIndex,
    required this.transportMode,
  })  : bytesReceived = 0,
        data = Uint8List(size);
}

class FileTransferHandler extends ChangeNotifier {
  final Map<String, FileInfo> _files = {};
  // Keep channel references to send ACK
  final Map<String, RTCDataChannel> _channels = {};

  List<FileInfo> get files => _files.values.toList();

  void handleChannel(RTCDataChannel channel) {
    final label = channel.label ?? '';
    debugPrint('[FileTransfer] New channel: $label');
    _channels[label] = channel;

    channel.onMessage = (RTCDataChannelMessage message) {
      debugPrint('[FileTransfer] $label message: isBinary=${message.isBinary} len=${message.isBinary ? message.binary.length : message.text.length}');
      if (message.isBinary) {
        _handleChunk(label, message.binary);
      } else {
        _handleText(label, message.text);
      }
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      debugPrint('[FileTransfer] $label state: $state');
    };
  }

  void _handleText(String channelLabel, String text) {
    try {
      final msg = jsonDecode(text) as Map<String, dynamic>;
      final type = msg['type'] as String?;
      final payload = msg['payload'] as Map<String, dynamic>?;

      if (type == 'FILE_META' && payload != null) {
        final info = FileInfo(
          id: payload['id'] as String,
          name: payload['name'] as String,
          size: payload['size'] as int,
          sha256: payload['sha256'] as String,
          generatorIndex: payload['generatorIndex'] as int? ?? 0,
          transportMode: payload['transportMode'] as String? ?? 'raw',
        );
        _files[info.id] = info;
        debugPrint('[FileTransfer] Got meta for ${info.name} (${info.size} bytes)');
        notifyListeners();
      } else if (type == 'EOF' && payload != null) {
        final fileId = payload['id'] as String;
        final info = _files[fileId];
        if (info != null) {
          _verifyFile(info, channelLabel);
        }
      } else if (type == 'CHUNK' && payload != null) {
        final fileId = payload['id'] as String;
        final offset = payload['offset'] as int;
        final info = _files[fileId];
        if (info == null || info.data == null) return;

        final chunkData = info.transportMode == 'descriptor'
            ? _generateChunk(
                info.generatorIndex,
                offset,
                payload['length'] as int,
              )
            : base64Decode(payload['dataBase64'] as String);
        info.data!.setRange(offset, offset + chunkData.length, chunkData);
        info.bytesReceived += chunkData.length;
        if (info.bytesReceived % (64 * 1024) < chunkData.length) {
          notifyListeners();
        }
      }
    } catch (e) {
      debugPrint('[FileTransfer] Text parse error: $e');
    }
  }

  void _handleChunk(String channelLabel, Uint8List data) {
    try {
      if (data.length < 4) return;

      final offset = ByteData.sublistView(data, 0, 4).getUint32(0, Endian.big);
      final chunkData = data.sublist(4);

      // Find file by matching channel label
      // Channel label is 'file-<uuid>'
      final fileId = channelLabel.replaceFirst('file-', '');
      final info = _files[fileId];

      if (info == null || info.data == null) return;

      info.data!.setRange(offset, offset + chunkData.length, chunkData);
      info.bytesReceived += chunkData.length;
      // Throttle notifications to avoid flooding UI rebuilds (notify every 64KB)
      if (info.bytesReceived % (64 * 1024) < chunkData.length) notifyListeners();
    } catch (e, st) {
      debugPrint('[FileTransfer] _handleChunk error: $e\n$st');
    }
  }

  void _verifyFile(FileInfo info, String channelLabel) {
    if (info.data == null) return;

    final digest = sha256.convert(info.data!);
    final remoteHash = digest.toString();

    info.verified = remoteHash == info.sha256;
    debugPrint('[FileTransfer] ${info.name}: verified=${info.verified}, '
        'local=$remoteHash, expected=${info.sha256}');

    // Send ACK back via the channel
    final channel = _channels[channelLabel];
    if (channel != null) {
      final ack = jsonEncode({
        'type': 'ACK',
        'payload': {
          'id': info.id,
          'ok': info.verified,
          'sha256': remoteHash,
        },
      });
      channel.send(RTCDataChannelMessage(ack));
      debugPrint('[FileTransfer] ACK sent for ${info.name}');
    }

    notifyListeners();
  }

  Uint8List _generateChunk(int fileIndex, int offset, int length) {
    final chunk = Uint8List(length);
    for (var i = 0; i < length; i++) {
      chunk[i] = (fileIndex * 17 + offset + i) & 0xff;
    }
    return chunk;
  }
}
