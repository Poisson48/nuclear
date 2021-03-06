import _ from 'lodash';
import logger from 'electron-timber';

import globals from '../../globals';
import core from 'nuclear-core';
import * as LastFmRestApi from '../../rest/LastFm';

let lastfm = new core.LastFmApi(globals.lastfmApiKey, globals.lastfmApiSecret);

/*
 * The following const will determine how random will be the next track compared to 
 * the previous ones.
 * The biggest impact are :
 * Very similar track < 0 --- AUTORADIO_TRACKS_DEVIATION --- 1 > Different track
 * Small variety of track < 0 --- SIMILAR_TRACKS_RESULTS_LIMIT --- 1 > Large variety
 */

/* 
 * Will determine wether when looking for similar tracks we stay close to the current tracks
 * Min = 0 - Max = 1 (0 will only accept the most similar track / 1 will go further down the list)
 * Example :
 * If set to 1 : autoradio is likely to play different styles of music
 * If set to 0.1 : autoradio is quite conservative and will stay in the same style
 */
let AUTORADIO_TRACKS_DEVIATION = 0.15;

/* 
 * No maximum
 * Will determine how many tracks in the queue do we take into account to get a similar track
 * Example :
 * If set to 1 : autoradio will select next track only based on the current track in queue
 * If set to 10 : autoradio will select next track based on the 10 latest tracks in the queue
 */
let AUTORADIO_IMPACTING_TRACK_NUMBER = 10;

/* 
 * No maximum
 * Will determine how many similar track we will be looking for each queue element. 
 * The higher, the highest is the chance of changing a lot the style of the future track
 * Example :
 * If set to 10 : for each element in the queue, we will look for 10 similar tracks
 * The next track will be chosen pseudo randomly between 
 * AUTORADIO_IMPACTING_TRACK_NUMBER * SIMILAR_TRACKS_RESULTS_LIMIT tracks
 * The more tracks, the more likely is the style to be changed
 */
let SIMILAR_TRACKS_RESULTS_LIMIT = 10;

/* 
 * Min = 0 - Max = 1 (0 will only accept the most similar artist / 1 will go further down the list)
 * Will determine wether when looking for similar artists we stay close to the current artist
 * This is only used in the case we cannot find similar tracks => we fall back to similar artist search
 */
let AUTORADIO_ARTIST_DEVIATION = 0.20;

function computeParameters (crazinessScore = 10) {
  AUTORADIO_ARTIST_DEVIATION = crazinessScore / 100;
  SIMILAR_TRACKS_RESULTS_LIMIT = crazinessScore;
  AUTORADIO_IMPACTING_TRACK_NUMBER = 101 - crazinessScore;
  AUTORADIO_TRACKS_DEVIATION = crazinessScore;
}

let props;
/**
 * addAutoradioTrackToQueue will first try to find tracks similar to the 
 * current queue. 
 * If no track is found, it will look for similar artists and choose a 
 * random track to play. 
 * It will remove all tracks which are already present in the queue.
 */
export function addAutoradioTrackToQueue (callProps) {
  props = callProps;
  let currentSong = props.queue.queueItems[props.queue.currentSong];
  computeParameters(props.settings.autoradioCraziness);

  return getSimilarTracksToQueue(AUTORADIO_IMPACTING_TRACK_NUMBER)
    .then(track => {
      if (track === null) {
        track = getNewTrack('artist', currentSong);
      }
      return track;
    })
    .then(selectedTrack => {
      if (selectedTrack === null) {
        return Promise.reject(new Error('No similar track or artist were found.'));
      }
      return addToQueue(selectedTrack.artist, selectedTrack);
    })
    .catch(function (err) {
      logger.error('error', err);
    });
}

function getSimilarTracksToQueue (number) {
  let similarTracksPromises = [];

  for (let i = props.queue.currentSong; i >= Math.max(0, props.queue.currentSong - number); i--) {
    similarTracksPromises.push(getSimilarTracks(props.queue.queueItems[i], SIMILAR_TRACKS_RESULTS_LIMIT));
  }
  return Promise.all(similarTracksPromises)
    .then(results => {
      let flattenResults = _.flatten(results);
      _.flatten(results).sort((a, b) => {
        return b.match - a.match;
      });
      let notInQueueResults = flattenResults.filter((track) => !isTrackInQueue(track));
      if (notInQueueResults.length > 0) {
        return getScoredRandomTrack(getArraySlice(notInQueueResults, AUTORADIO_TRACKS_DEVIATION));
      } else {
        return null;
      }
    });
}

function getScoredRandomTrack (tracks) {
  let sum = 0;
  let cumulativeBias = tracks.map(function (track) {
    sum += track.match; return sum;
  });
  let choice = Math.random() * sum;
  let chosenIndex = null;
  cumulativeBias.some(function (el, i) {
    return el >= choice ? ((chosenIndex = i), true) : false;
  });
  return Promise.resolve(tracks[chosenIndex]);
}

function getTrackNotInQueue (tracks, deviation) {
  let newtracks = tracks.filter((track) => !isTrackInQueue(track));
  return getRandomElement(getArraySlice(newtracks, deviation));
}

function getArraySlice (arr, ratio) {
  return arr.slice(0, Math.round((arr.length - 1) * ratio) + 1);
}

function getNewTrack (getter, track) {
  let getTrack;
  if (getter === 'track') {
    getTrack = getSimilarTracks(track);
  } else {
    getTrack = getTracksFromSimilarArtist(track.artist);
  }
  return getTrack
    .then(similarTracks => {
      return (getTrackNotInQueue(similarTracks, AUTORADIO_TRACKS_DEVIATION) || null);
    });
}

function isTrackInQueue (track) {
  let queue = props.queue.queueItems;
  for (let i in queue) {
    if (queue[i].artist === track.artist.name && queue[i].name === track.name) {
      return true;
    }
  }
  return false;
}

function getSimilarTracks (currentSong, limit = 100) {
  return LastFmRestApi.getSimilarTracks(currentSong.artist, currentSong.name, limit)
    .then(tracks => tracks.json())
    .then(trackJson => {
      return _.get(trackJson, 'similartracks.track', []);
    });
}

function getTracksFromSimilarArtist (artist) {
  return lastfm
    .getArtistInfo(artist)
    .then(artist => artist.json())
    .then(artistJson => getSimilarArtists(artistJson))
    .then(similarArtists => {
      let similarArtist = getRandomElement(getArraySlice(similarArtists, AUTORADIO_ARTIST_DEVIATION));
      return similarArtist;
    })
    .then(selectedArtist => getArtistTopTracks(selectedArtist))
    .then(topTracks => _.get(topTracks, 'toptracks.track', []));
}

function getSimilarArtists (artistJson) {
  return Promise.resolve(artistJson.artist.similar.artist);
}

function getRandomElement (arr) {
  return arr[Math.round(Math.random() * (arr.length - 1))];
}

function getArtistTopTracks (artist) {
  return lastfm
    .getArtistTopTracks(_.get(artist, 'name', artist))
    .then(topTracks => {

      return topTracks.json();
    });
}

function addToQueue (artist, track) {
  return new Promise((resolve) => {
    let musicSources = props.plugins.plugins.musicSources;
    props.actions.addToQueue(musicSources, {
      artist: artist.name,
      name: track.name,
      thumbnail: track.image[0]['#text']
    });
    resolve(true);
  });
}

