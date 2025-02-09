var device = null;
(function() {
    'use strict';

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function formatDFUSummary(device) {
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    function formatDFUInterfaceAlternate(settings) {
        let mode = "Unknown"
        if (settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        const name = (settings.name) ? settings.name : "UNKNOWN";

        return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
    }

    async function fixInterfaceNames(device_, interfaces) {
        // Check if any interface names were not read correctly
        if (interfaces.some(intf => (intf.name == null))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function populateInterfaceList(form, device_, interfaces) {
        let old_choices = Array.from(form.getElementsByTagName("div"));
        for (let radio_div of old_choices) {
            form.removeChild(radio_div);
        }

        let button = form.getElementsByTagName("button")[0];

        for (let i=0; i < interfaces.length; i++) {
            let radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "interfaceIndex";
            radio.value = i;
            radio.id = "interface" + i;
            radio.required = true;

            let label = document.createElement("label");
            label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
            label.className = "radio"
            label.setAttribute("for", "interface" + i);

            let div = document.createElement("div");
            div.appendChild(radio);
            div.appendChild(label);
            form.insertBefore(div, button);
        }
    }

    function getDFUDescriptorProperties(device) {
        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        // CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        // TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    // Current log div element to append to
    let logContext = null;

    function setLogContext(div) {
        logContext = div;
    };

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            context.innerHTML = "";
        }
    }

    function logDebug(msg) {
        console.log(msg);
    }

    function logInfo(msg) {
        console.log(msg);
    }

    function logWarning(msg) {
        console.log(msg);
    }

    function logError(msg) {
        console.log(msg);
    }

    function logProgress(done, total) {
        let progressBar = document.querySelector("#downloadProgress");
        progressBar.setAttribute('style','width:'+ Number(Math.floor(done / total * 100)) + '%');
    }

    document.addEventListener('DOMContentLoaded', event => {
        let connectButton = document.querySelector("#connect");
        let disconnectButton = document.querySelector("#disconnect");
        let connectDiv = document.querySelector("#connectDiv");
        let connectedDiv = document.querySelector("#connectedDiv");
        let connected2Div = document.querySelector("#connected2Div");
        let downloadFormDiv = document.querySelector("#downloadFormDiv");
        let downloadActiveDiv = document.querySelector("#downloadActiveDiv");
        let downloadIncompleteDiv = document.querySelector("#downloadIncompleteDiv");
        let downloadCompleteDiv = document.querySelector("#downloadCompleteDiv");
        let errorDiv = document.querySelector("#errorDiv");
        let errorMessageDiv = document.querySelector("#errorMessageDiv");
        // let detachButton = document.querySelector("#detach");
        let downloadButton = document.querySelector("#download");
        // let reloadButton = document.querySelector("#reloadButton");
        // let uploadButton = document.querySelector("#upload");
        let statusDisplay = document.querySelector("#status");
        // let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let vidField = document.querySelector("#vid");
        let interfaceDialog = document.querySelector("#interfaceDialog");
        let interfaceForm = document.querySelector("#interfaceForm");
        let interfaceSelectButton = document.querySelector("#selectInterface");

        let deviceInfoManufacturer = document.querySelector("#deviceInfoManufacturer");
        let deviceInfoName = document.querySelector("#deviceInfoName");
        let deviceInfoSerial = document.querySelector("#deviceInfoSerial");

        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;
        let vid = 0;
        // Set the vendor ID from the landing page URL
        if (searchParams.has("vid")) {
            const vidString = searchParams.get("vid");
            try {
                if (vidString.toLowerCase().startsWith("0x")) {
                    vid = parseInt(vidString, 16);
                } else {
                    vid = parseInt(vidString, 10);
                }
                vidField.value = "0x" + hex4(vid).toUpperCase();
                fromLandingPage = true;
            } catch (error) {
                console.log("Bad VID " + vidString + ":" + error);
            }
        }

        // Grab the serial number from the landing page
        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            // Workaround for Chromium issue 339054
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");

        // let transferSizeField = document.querySelector("#transferSize");
        // let transferSize = parseInt(transferSizeField.value);
        let transferSize = 0x1000;

        // let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        // let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize");

        let firmwareFileField = document.querySelector("#firmwareFile");
        let firmwareFile = null;

        let downloadLog = document.querySelector("#downloadLog");
        // let uploadLog = document.querySelector("#uploadLog");

        let manifestationTolerant = true;

        //let device;

        function onDisconnect(reason) {
            if (reason) {
                statusDisplay.textContent = reason;
                console.log(reason);
            }

            connectDiv.style.display = "";
            downloadFormDiv.style.display = "none";
            downloadActiveDiv.style.display = "none";
            connectedDiv.style.display = "none";
            connected2Div.style.display = "none";
            // connectButton.textContent = "Connect";
            // infoDisplay.textContent = "";

            // deviceInfoManufacturer.textContent = "TODO: hide";

            dfuDisplay.textContent = "";
            // detachButton.disabled = true;
            // uploadButton.disabled = true;
            // downloadButton.disabled = true;
            firmwareFileField.disabled = true;
        }

        function onUnexpectedDisconnect(event) {
            // if (device !== null && device.device_ !== null) {
            if (device != null && device.device_ != null) {
                if (device.device_ === event.device) {
                    errorMessageDiv.textContent = "Device disconnected";
                    errorDiv.style.display = "";
                    device.disconnected = true;
                    onDisconnect("Device disconnected");
                    device = null;
                }
            }
        }

        async function connect(device) {
            errorDiv.style.display = "none";
            try {
                await device.open();
            } catch (error) {
                errorMessageDiv.textContent = error;
                errorDiv.style.display = "";
                onDisconnect(error);
                throw error;
            }

            // Attempt to parse the DFU functional descriptor
            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                errorMessageDiv.textContent = error;
                errorDiv.style.display = "";
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                // let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                // let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanDnload=${desc.CanDnload}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                dfuDisplay.textContent += "\n" + info;
                // transferSizeField.value = desc.TransferSize;
                // transferSize = desc.TransferSize;
                transferSize = 0x1000;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02) {
                    if (!desc.CanDnload) {
                            console.log('cannot download');
                            errorMessageDiv.textContent = "Device does not accept firmware downloads"
                            errorDiv.style.display = "";
                                device.close().then(onDisconnect);
                                device = null;
                            // downloadButton.disabled = true;
                            return;
                    }
                }
            }

            // Bind logging methods
            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            // Clear logs
            // clearLog(uploadLog);
            clearLog(downloadLog);

            // Display basic USB information
            statusDisplay.textContent = '';
            // connectButton.textContent = 'Disconnect';
            connectedDiv.style.display = "";
            connected2Div.style.display = "";
            downloadFormDiv.style.display = "";
            connectDiv.style.display = "none";
            downloadActiveDiv.style.display = "none";
            // infoDisplay.textContent = (
            //     "Name: " + device.device_.productName + "\n" +
            //     "MFG: " + device.device_.manufacturerName + "\n" +
            //     "Serial: " + device.device_.serialNumber + "\n"
            // );

            deviceInfoManufacturer.textContent = device.device_.manufacturerName;
            deviceInfoName.textContent = device.device_.productName;
            deviceInfoSerial.textContent = device.device_.serialNumber;

            // Display basic dfu-util style info
            dfuDisplay.textContent = formatDFUSummary(device) + "\n" + memorySummary;

            // Update buttons based on capabilities
            if (device.settings.alternate.interfaceProtocol == 0x01) {
                // Runtime
                // detachButton.disabled = false;
                // uploadButton.disabled = true;
                // downloadButton.disabled = true;
                firmwareFileField.disabled = true;
            } else {
                // DFU
                // detachButton.disabled = true;
                // uploadButton.disabled = false;
                // downloadButton.disabled = false;
                firmwareFileField.disabled = false;
            }

            return device;
        }

        function autoConnect(vid, serial) {
            dfu.findAllDfuInterfaces().then(
                async dfu_devices => {
                    let matching_devices = [];
                    for (let dfu_device of dfu_devices) {
                        if (serial) {
                            if (dfu_device.device_.serialNumber == serial) {
                                matching_devices.push(dfu_device);
                            }
                        } else if (dfu_device.device_.vendorId == vid) {
                            matching_devices.push(dfu_device);
                        }
                    }

                    if (matching_devices.length == 0) {
                        statusDisplay.textContent = 'No device found.';
                        console.log('No device found.');
                    } else {
                        if (matching_devices.length == 1) {
                            statusDisplay.textContent = 'Connecting...';
                            console.log('Connecting...');
                            device = matching_devices[0];
                            console.log(device);
                            device = await connect(device);
                        } else {
                            statusDisplay.textContent = "Multiple DFU interfaces found.";
                            console.log("Multiple DFU interfaces found.");
                        }
                        vidField.value = "0x" + hex4(matching_devices[0].device_.vendorId).toUpperCase();
                        vid = matching_devices[0].device_.vendorId;
                    }
                }
            );
        }

        vidField.addEventListener("change", function() {
            vid = parseInt(vidField.value, 16);
        });

        disconnectButton.addEventListener('click', function() {
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            }
            errorDiv.style.display = "none";
        });

        // reloadButton.addEventListener('click', function() {
        //     window.location.reload();
        // });

        connectButton.addEventListener('click', function() {
            errorDiv.style.display = "none";
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = [];
                if (serial) {
                    filters.push({ 'serialNumber': serial });
                } else if (vid) {
                    filters.push({ 'vendorId': vid });
                }
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        if (interfaces.length == 0) {
                            console.log(selectedDevice);
                            statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
                            console.log("The selected device does not have any USB DFU interfaces.");
                            errorMessageDiv.textContent = "Device does not support DFU";
                            errorDiv.style.display = "";
                        } else if (interfaces.length == 1) {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            device = await connect(new dfu.Device(selectedDevice, interfaces[0]));
                        } else {
                            await fixInterfaceNames(selectedDevice, interfaces);
                            populateInterfaceList(interfaceForm, selectedDevice, interfaces);
                            async function connectToSelectedInterface() {
                                interfaceForm.removeEventListener('submit', this);
                                const index = interfaceForm.elements["interfaceIndex"].value;
                                device = await connect(new dfu.Device(selectedDevice, interfaces[index]));
                            }

                            interfaceForm.addEventListener('submit', connectToSelectedInterface);

                            interfaceDialog.addEventListener('cancel', function () {
                                interfaceDialog.removeEventListener('cancel', this);
                                interfaceForm.removeEventListener('submit', connectToSelectedInterface);
                            });

                            interfaceDialog.showModal();
                        }
                    }
                ).catch(error => {
                    console.log(error);
                    if(!error.message.includes("No device selected"))
                    {
                        statusDisplay.textContent = error;
                        errorMessageDiv.textContent = error;
                        errorDiv.style.display = "";
                    }
                });
            }
        });

        firmwareFileField.addEventListener("change", function() {
            firmwareFile = null;
            if (firmwareFileField.files.length > 0) {
                let file = firmwareFileField.files[0];
                let reader = new FileReader();
                reader.onload = function() {
                    firmwareFile = reader.result;
                };
                reader.readAsArrayBuffer(file);
                downloadButton.disabled = false;
            }
            else
            {
                downloadButton.disabled = true;
            }
        });

        downloadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            errorDiv.style.display = "none";
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                errorMessageDiv.textContent = "No file selected";
                errorDiv.style.display = "";
                return false;
            }

            if (device && firmwareFile != null) {
                setLogContext(downloadLog);
                clearLog(downloadLog);
                try {
                    let status = await device.getStatus();
                    if (status.state == dfu.dfuERROR) {
                        await device.clearStatus();
                    }
                } catch (error) {
                    device.logWarning("Failed to clear status");
                }
                downloadActiveDiv.style.display = "";
                downloadFormDiv.style.display = "none";
                await device.do_download(transferSize, firmwareFile, manifestationTolerant).then(
                    () => {
                        logInfo("Done!");
                        setLogContext(null);
                        downloadCompleteDiv.style.display = "";
                        downloadIncompleteDiv.style.display = "none";
                        device.close().then(onDisconnect);
                        // if (!manifestationTolerant) {
                        //     device.waitDisconnected(5000).then(
                        //         dev => {
                        //             onDisconnect();
                        //             device = null;
                        //         },
                        //         error => {
                        //             // It didn't reset and disconnect for some reason...
                        //             console.log("Device unexpectedly tolerated manifestation.");
                        //         }
                        //     );
                        // }
                    },
                    error => {
                        logError(error);
                        downloadFormDiv.style.display = "";
                        downloadActiveDiv.style.display = "none";
                        if(
                            // Exclude errors that occur when the device is deliberately disconnected
                            !(
                                error.includes("The transfer was cancelled") ||
                                error.includes("The device must be opened first") ||
                                (
                                    error.message && (
                                        error.message.includes("The transfer was cancelled") ||
                                        error.message.includes("The device must be opened first")
                                    )
                                )
                            )
                        )
                        {
                            errorMessageDiv.textContent = error;
                            errorDiv.style.display = "";
                        }
                        setLogContext(null);
                    }
                )
            }

            //return false;
        });

        // Check if WebUSB is available
        if (typeof navigator.usb !== 'undefined') {
            errorDiv.style.display = "none";
            connectDiv.style.display = "";
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
            // Try connecting automatically
            if (fromLandingPage) {
                autoConnect(vid, serial);
            }
        } else {
            console.log("WebUSB not available");
            statusDisplay.textContent = 'WebUSB not available.'
            connectButton.disabled = true;
            errorMessageDiv.textContent = 'WebUSB not available';
            errorDiv.style.display = "";
        }
    });
})();
