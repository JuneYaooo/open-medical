import json, os
print(json.dumps({"hello": "offline plugin", "uid": os.getuid(), "workspace": os.getcwd()}))
