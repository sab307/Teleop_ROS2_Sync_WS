# Teleop_ROS2_Sync_WS
Synchronized Teleop WS
### Golang Server
```bash
cd go_relay
go run .
```

### Python Script
Make sure the ros is properly sourced and the
topic your subscribing to is in the terminal, 
before running the python script.
```bash
cd python-client-modular
. /opt/ros/humble/setup.bash
python3 Main.py --topic /turtle1/cmd_vel
```
OR 
```bash
cd python-client
. /opt/ros/humble/setup.bash
python3 main.py --topic /turtle1/cmd_vel
```