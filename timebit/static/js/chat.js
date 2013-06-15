
if (!console || !console.log) {
  var console = {
    log: function() {}
  };
}

// Ugh, globals.
var peerc;
var myUserID;
var mainRef = new Firebase("https://kix.firebaseio.com/gupshup/");

// Shim Firefox & Chrome. Interop stuff.
var makePC = null;
var browser = null;
var getUserMedia = null;
var RTCPeerConnection = null;
var attachMediaStream = null;
var mediaConstraints = {
  "mandatory": {
    "OfferToReceiveAudio":true, 
    "OfferToReceiveVideo":true
  }
};

// Add an a=crypto line for SDP emitted by Firefox.
// This is backwards compatibility for Firefox->Chrome calls because
// Chrome will not accept a=crypto-less offers and Firefox only
// does DTLS-SRTP.
function ensureCryptoLine(sdp) {
  if (browser !== "firefox") {
    return sdp;
  }

  var sdpLinesIn = sdp.split('\r\n');
  var sdpLinesOut = [];

  // Search for m line.
  for (var i = 0; i < sdpLinesIn.length; i++) {
    sdpLinesOut.push(sdpLinesIn[i]);
    if (sdpLinesIn[i].search('m=') !== -1) {
      sdpLinesOut.push("a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    } 
  }

  sdp = sdpLinesOut.join('\r\n');
  return sdp;
}

function adapter() {
  // https://code.google.com/p/webrtc-samples/source/browse/trunk/apprtc/js/adapter.js.
  if (navigator.mozGetUserMedia) {
    browser = "firefox";
    makePC = function() {
      return new mozRTCPeerConnection({
        "iceServers": [{"url": "stun:23.21.150.121"}]
      }, {"optional": []});
    };
    getUserMedia = navigator.mozGetUserMedia.bind(navigator);
    attachMediaStream = function(element, stream) {
      element.mozSrcObject = stream;
      element.play();
    };
    mediaConstraints.mandatory["MozDontOfferDataChannel"] = true;
    window.RTCIceCandidate = window.mozRTCIceCandidate;
    window.RTCSessionDescription = window.mozRTCSessionDescription;
  } else if (navigator.webkitGetUserMedia) {
    browser = "chrome";
    makePC = function() {
      return new webkitRTCPeerConnection({
        "iceServers": [{"url": "stun:stun.l.google.com:19302"}],
      }, {"optional": [{"DtlsSrtpKeyAgreement": true}]});
    };
    getUserMedia = navigator.webkitGetUserMedia.bind(navigator);
    attachMediaStream = function(element, stream) {
      element.src = webkitURL.createObjectURL(stream);
      element.play();
    };
  }
}

// App logic starts.

$("#incomingCall").modal();
$("#incomingCall").modal("hide");

function prereqs() {
  if (!navigator.mozGetUserMedia && !navigator.webkitGetUserMedia) {
    error("Sorry, getUserMedia is not available!");
    return;
  }
  if (!window.mozRTCPeerConnection && !window.webkitRTCPeerConnection) {
    error("Sorry, PeerConnection is not available!");
    return;
  }
  adapter();

  // Ask user to login.
  var name = prompt("Enter your username", "Guest" + Math.floor(Math.random()*100)+1);

  // Set username & welcome.
  document.getElementById("username").innerHTML = name;
  document.getElementById("welcome").style.display = "block";

  myUserID = btoa(name);
  var userRef = mainRef.child(myUserID);
  var userSDP = userRef.child("sdp");
  var userICE = userRef.child("ice");
  var userStatus = userRef.child("presence");

  userSDP.onDisconnect().remove();
  userStatus.onDisconnect().set(false);

  $(window).unload(function() {
    userSDP.set(null);
    userStatus.set(false);
  });

  // Now online.
  userStatus.set(true);

  mainRef.on("child_added", function(snapshot) {
    var data = snapshot.val();
    if (data.presence) {
      appendUser(snapshot.name());
    }
  });

  mainRef.on("child_changed", function(snapshot) {
    var data = snapshot.val();
    if (data.presence) {
      removeUser(snapshot.name());
      appendUser(snapshot.name());
    }
    if (!data.presence) {
      removeUser(snapshot.name());
    }
    if (data.sdp && data.sdp.to == myUserID) {
      if (data.sdp.type == "offer") {
        incomingOffer(data.sdp.offer, data.sdp.from)
        userSDP.set(null);
      }
      if (data.sdp.type == "answer") {
        incomingAnswer(data.sdp.answer);
        userSDP.set(null);
      }
    }
    if (data.ice && data.ice.to == myUserID) {
      var candidate = new RTCIceCandidate({
        sdpMLineIndex: data.ice.label, candidate: data.ice.candidate
      });
      peerc.addIceCandidate(candidate);
      userICE.set(null);
    }
  });
}

function error(msg) {
  document.getElementById("message").innerHTML = msg;
  document.getElementById("alert").style.display = "block";
}

$("#incomingCall").on("hidden", function() {
  document.getElementById("incomingRing").pause();
});

function incomingOffer(offer, fromUser) {
  document.getElementById("incomingUser").innerHTML = atob(fromUser);
  document.getElementById("incomingAccept").onclick = function() {
    $("#incomingCall").modal("hide");
    acceptCall(offer, fromUser);
  };
  $("#incomingCall").modal();
  document.getElementById("incomingRing").play();
};

function incomingAnswer(answer) {
  var desc = new RTCSessionDescription(JSON.parse(answer));
  peerc.setRemoteDescription(desc, function() {
    log("Call established!");
  }, error);
};

function log(info) {
  var d = document.getElementById("debug");
  d.innerHTML += info + "\n\n";
}

function appendUser(userid) {
  if (userid == myUserID) return;
  var d = document.createElement("div");
  d.setAttribute("id", userid);

  var a = document.createElement("a");
  a.setAttribute("class", "btn btn-block btn-inverse");
  a.setAttribute("onclick", "initiateCall('" + userid + "');");
  a.innerHTML = "<i class='icon-user icon-white'></i> " + atob(userid);

  d.appendChild(a);
  d.appendChild(document.createElement("br"));
  document.getElementById("users").appendChild(d);
}

function removeUser(userid) {
  var d = document.getElementById(userid);
  if (d) {
    document.getElementById("users").removeChild(d);
  }
}

// TODO: refactor, this function is almost identical to initiateCall().
function acceptCall(offer, fromUser) {
  log("Incoming call with offer " + offer);
  document.getElementById("main").style.display = "none";
  document.getElementById("call").style.display = "block";

  getUserMedia({video:true, audio:true}, function(vs) {
    attachMediaStream(document.getElementById("localvideo"), vs);
    var pc = makePC();
    peerc = pc;
    pc.onicecandidate = function(event) {
      if (event.candidate) {
        var iceSend = {
          to: fromUser,
          label: event.candidate.sdpMLineIndex,
          id: event.candidate.sdpMid,
          candidate: event.candidate.candidate
        };
        mainRef.child(iceSend.to).child("ice").set(iceSend);
      } else {
        log("End of ICE candidates");
      }
    };
    pc.addStream(vs);

    pc.onaddstream = function(obj) {
      log("Got onaddstream of type " + obj.type);
      attachMediaStream(document.getElementById("remotevideo"), obj.stream);
      document.getElementById("dialing").style.display = "none";
      document.getElementById("hangup").style.display = "block";
    };

    var desc = new RTCSessionDescription(JSON.parse(offer));
    pc.setRemoteDescription(desc, function() {
      log("setRemoteDescription, creating answer");
      pc.createAnswer(function(answer) {
        answer.sdp = ensureCryptoLine(answer.sdp);
        pc.setLocalDescription(answer, function() {
          // Send answer to remote end.
          log("created Answer and setLocalDescription " + JSON.stringify(answer));
          var toSend = {
            type: "answer",
            to: fromUser,
            from: myUserID,
            answer: JSON.stringify(answer)
          };
          var toUser = mainRef.child(toSend.to);
          var toUserSDP = toUser.child("sdp");
          toUserSDP.set(toSend);
        }, error);
      }, error, mediaConstraints);
    }, error);
  }, error);
}

function initiateCall(userid) {
  document.getElementById("main").style.display = "none";
  document.getElementById("call").style.display = "block";

  getUserMedia({video:true, audio:true}, function(vs) {
    attachMediaStream(document.getElementById("localvideo"), vs);
    var pc = makePC();
    peerc = pc;
    pc.onicecandidate = function(event) {
      if (event.candidate) {
        var iceSend = {
          to: userid,
          label: event.candidate.sdpMLineIndex,
          id: event.candidate.sdpMid,
          candidate: event.candidate.candidate
        };
        mainRef.child(iceSend.to).child("ice").set(iceSend);
      } else {
        log("End of ICE candidates");
      }
    };
    pc.addStream(vs);

    pc.onaddstream = function(obj) {
      log("Got onaddstream of type " + obj.type);
      attachMediaStream(document.getElementById("remotevideo"), obj.stream);
      document.getElementById("dialing").style.display = "none";
      document.getElementById("hangup").style.display = "block";
    };

    pc.createOffer(function(offer) {
      offer.sdp = ensureCryptoLine(offer.sdp);
      log("Created offer" + JSON.stringify(offer));
      pc.setLocalDescription(offer, function() {
        // Send offer to remote end.
        log("setLocalDescription, sending to remote");
        var toSend = {
          type: "offer",
          to: userid,
          from: myUserID,
          offer: JSON.stringify(offer)
        };
        var toUser = mainRef.child(toSend.to);
        var toUserSDP = toUser.child("sdp");
        toUserSDP.set(toSend);
      }, error);
    }, error, mediaConstraints);
  }, error);
}

function endCall() {
  log("Ending call");
  document.getElementById("call").style.display = "none";
  document.getElementById("main").style.display = "block";

  document.getElementById("localvideo").pause();
  document.getElementById("remotevideo").pause();
  document.getElementById("localvideo").src = null;
  document.getElementById("remotevideo").src = null;

  peerc = null;
}

function error(e) {
  if (typeof e == typeof {}) {
    alert("Oh no! " + JSON.stringify(e));
  } else {
    alert("Oh no! " + e);
  }
  endCall();
}

prereqs();

