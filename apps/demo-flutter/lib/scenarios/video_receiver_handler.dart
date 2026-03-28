import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

class VideoReceiverHandler extends ChangeNotifier {
  int framesReceived = 0;
  int framesDropped = 0;
  int fps = 0;
  DateTime? startTime;
  int _fpsCounter = 0;

  final ValueNotifier<ui.Image?> currentFrame = ValueNotifier(null);

  bool _decoding = false;

  void handleChannel(RTCDataChannel channel) {
    debugPrint('[Video] Channel ready');
    startTime = DateTime.now();

    // FPS counter
    _startFpsCounter();

    channel.onMessage = (RTCDataChannelMessage message) {
      if (message.isBinary) {
        _handleFrame(message.binary);
      }
    };

    channel.onDataChannelState = (RTCDataChannelState state) {
      debugPrint('[Video] State: $state');
    };
  }

  void _handleFrame(Uint8List data) {
    // Frame format: [4B frameId][4B w][4B h][8B ts_ms][w*h*4 RGBA]
    if (data.length < 20) return;

    final bd = ByteData.sublistView(data);
    // final frameId = bd.getUint32(0, Endian.big);
    final w = bd.getUint32(4, Endian.big);
    final h = bd.getUint32(8, Endian.big);
    // final tsMs = bd.getInt64(12, Endian.big);

    final expected = 20 + w * h * 4;
    if (data.length < expected) {
      framesDropped++;
      notifyListeners();
      return;
    }

    // If already decoding, drop frame to maintain real-time
    if (_decoding) {
      framesDropped++;
      notifyListeners();
      return;
    }

    _decoding = true;
    final pixels = data.sublist(20, expected);

    ui.decodeImageFromPixels(
      pixels,
      w,
      h,
      ui.PixelFormat.rgba8888,
      (img) {
        currentFrame.value = img;
        framesReceived++;
        _fpsCounter++;
        _decoding = false;
        notifyListeners();
      },
    );
  }

  void _startFpsCounter() {
    Future.doWhile(() async {
      await Future.delayed(const Duration(seconds: 1));
      fps = _fpsCounter;
      _fpsCounter = 0;
      notifyListeners();
      return true;
    });
  }

  @override
  void dispose() {
    currentFrame.dispose();
    super.dispose();
  }
}
