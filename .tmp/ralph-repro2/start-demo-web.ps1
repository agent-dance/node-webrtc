$env:PATH = 'C:\Users\buthim\Documents\GitHub\node-webrtc\.tmp\bin;' + $env:PATH
$env:DEMO_SCENARIOS = '1,2,3'
$env:DEMO_SCENARIO2_TOTAL_SIZE = '33554432'
Set-Location 'C:\Users\buthim\Documents\GitHub\node-webrtc\apps\demo-web'
pnpm start
