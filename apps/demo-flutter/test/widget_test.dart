import 'package:flutter_test/flutter_test.dart';

import 'package:demo_flutter/main.dart';

void main() {
  testWidgets('renders demo home screen', (WidgetTester tester) async {
    await tester.pumpWidget(const DemoApp(autoConnect: false));
    await tester.pump();

    expect(find.text('ts-rtc P2P Demo'), findsAtLeastNWidgets(1));
    expect(find.text('Select a Scenario'), findsOneWidget);
  });
}
