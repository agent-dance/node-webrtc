$env:PATH = 'C:\Users\buthim\Documents\GitHub\node-webrtc\.tmp\bin;' + $env:PATH
$env:DEMO_SCENARIOS = '1'
Set-Location 'C:\Users\buthim\Documents\GitHub\node-webrtc\apps\demo-web'
pnpm start
