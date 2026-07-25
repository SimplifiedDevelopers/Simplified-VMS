{
  "variables": {
    "hik_sdk_dir%": "<!(python -c \"import os; print(os.environ.get('HIK_SDK_DIR', ''))\")"
  },
  "targets": [
    {
      "target_name": "hikvision_native",
      "sources": ["src/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(hik_sdk_dir)/incEn"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "<(hik_sdk_dir)/lib/HCNetSDK.lib",
              "<(hik_sdk_dir)/lib/PlayCtrl.lib"
            ]
          }
        ]
      ],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      }
    }
  ]
}
