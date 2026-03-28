import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'services/signaling_service.dart';
import 'services/webrtc_service.dart';
import 'screens/home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DemoApp());
}

class DemoApp extends StatelessWidget {
  const DemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) {
          final sig = SignalingService();
          // Auto-connect on startup for automated testing
          WidgetsBinding.instance.addPostFrameCallback((_) => sig.connect());
          return sig;
        }),
        ChangeNotifierProxyProvider<SignalingService, WebRtcService>(
          create: (ctx) => WebRtcService(ctx.read<SignalingService>()),
          update: (ctx, sig, prev) => prev ?? WebRtcService(sig),
        ),
      ],
      child: MaterialApp(
        title: 'ts-rtc P2P Demo',
        theme: ThemeData.dark(useMaterial3: true).copyWith(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFF58a6ff),
            brightness: Brightness.dark,
          ),
        ),
        home: const HomeScreen(),
      ),
    );
  }
}
