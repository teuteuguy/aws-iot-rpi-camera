var aws = require('aws-sdk'); // For S3
var awsIot = require('aws-iot-device-sdk'); // For IoT
var fs = require('fs');
var config = require('./config.json');
var Camera = require('camerapi');
var cam = new Camera();

cam.baseFolder(config.localStorage);

console.log('Loaded config:', config);

var configIoT = {
    "keyPath": config.iotKeyPath,
    "certPath": config.iotCertPath,
    "caPath": config.iotCaPath,
    "clientId": config.iotClientId,
    "region": config.iotRegion,
    "reconnectPeriod": 5000,
    "host": config.iotEndpoint
};

var device = awsIot.device(configIoT);


var s3Client = new aws.S3();

device.on('connect', function() {
    console.log('Connection established to AWS IoT');
    console.log('Subscribing to topic', config.iotTriggerTopic);
    device.subscribe('chip/button');
});

device.on('message', function(topic, payload) {

    console.log('Message received on topic', topic, 'with message', payload.toString());

    var filename = Date.now() + '.jpg';

    cam.prepare({
        timeout: 0,
        quality: 15,
        width: 800,
        height: 600
    }).takePicture(filename, function(file, err) {

        if (!err) {

            console.log('Tacking picture to', file);

            var fileBuffer = fs.readFileSync(config.localStorage + '/' + filename);

            var key = '';
            if (config.s3BucketFolder && config.s3BucketFolder.length > 0) key += config.s3BucketFolder + '/';
            key += filename;

            s3Client.putObject({
                ACL: 'public-read',
                Bucket: config.s3Bucket,
                Key: key,
                Body: fileBuffer,
                ContentType: 'image/jpg'
            }, function(error, response) {
                if (!error) {
                  console.log('Upload to S3 finished', arguments);
                  console.log('Publishing to', config.iotPublishTopic);
                  device.publish(config.iotPublishTopic, key);
                } else {
                  console.error('ERROR', error);
                }
            });

        } else {

            console.error('ERROR: ', err);
        }


    });


});
