#aws-iot-rpi-camera

This is my fun code for connecting a Raspberry Pi, using the camera, to AWS IoT.


### Pre-Requisites:

* Raspberry Pi
* Raspberry Pi Camera
* node.js on Raspberry Pi

### Installation

git pull https://github.com/teuteuguy/aws-iot-rpi-camera

Copy the config.json.sample to config.json and fill in the different fields.

### Run

node index.js

### AWS IoT Shadow config

Setup the Desired part of your Thing Shadow with the following values:

"desired": {
    "rpi-camera": {
      "cameraRotation": 180,
      "iotTriggerTopic": "topic you want to use to trigger taking a picture",
      "s3Bucket": "the s3 bucket where files will be sent to",
      "s3BucketFolder": "folder in the bucket",
      "cognitoRegion": "region for cognito",
      "cognitoIdentityPoolId": "cognito endpoint",
      "iotUploadedTopic": "topic you want to use for getting uploaded notifications"
    }
  }

##Disclaimer

The code in this repository is provided "as is". It may not be sufficient for production environments. Be careful and inspect the code before running it.
This code is my personal shit, has nothing to do with my employer.

_Use at your own risk._