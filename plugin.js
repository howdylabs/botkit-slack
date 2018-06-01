var express = require('express');
var path = require('path');
var async = require('async');
const { WebClient } = require('@slack/client');

var slack_team_schema = {
    id: {
        type: String,
        index: true,
    },
    auth: {
      type: String,
    },
    created: {
        type: Date,
        default: Date.now,
    },
    modified: {
        type: Date,
        default: Date.now,
    },
}

var slack_user_schema = {
    id: {
        type: String,
        index: true,
    },
    team: {
      type: String,
      index: true,
    },
    token: {
      type: String,
    },
    created: {
        type: Date,
        default: Date.now,
    },
    modified: {
        type: Date,
        default: Date.now,
    },
}


module.exports = function(botkit) {

    var config = botkit.config.slack || {};

    if (!config.api_root) { config.api_root = 'https://slack.com'; }
    if (!config.scopes) { config.scopes = ['bot']; }
    if (!config.login_success_url) { config.login_success_url = '/'; }

    if (!config.clientId || !config.clientSecret) {
      console.error('Slack is not configured. Please specify a clientId and clientSecret.')
    }

    var plugin = {
        name: 'Botkit for Slack',
        web: [{
            url: '/admin/slack',
            method: 'get',
            handler: function(req, res) {
              var relativePath = path.relative(botkit.LIB_PATH + '/../views', __dirname + '/views');
                res.render(relativePath + '/config');
            }
        },
        {
          url: '/slack/configure',
          method: 'get',
          handler: function(req, res) {
            var relativePath = path.relative(botkit.LIB_PATH + '/../views', __dirname + '/views');
              res.render(relativePath + '/config');
          }
        },
        {
            url: '/slack/login',
            method: 'get',
            handler: function(req, res) {

              if (!config.clientId || !config.clientSecret) {
                res.redirect('/slack/configure');
              } else {
                var scopes = config.scopes;
                var api_root = config.api_root;

                var url = api_root + '/oauth/authorize?client_id=' +
                    config.clientId + '&scope=' + scopes.join(',') + '&state=botkit';

                if (config.redirectUri) {
                    var redirect_query = '';
                    var redirect_uri = config.redirectUri;
                    url += '&redirect_uri=' + redirect_uri;
                }

                res.redirect(url);
              }
            }
        },
        {
            url: '/slack/oauth',
            method: 'get',
            handler: function(req, res) {

              var code = req.query.code;
              var state = req.query.state;
              var slack = new WebClient();
              slack.oauth.access({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code
              }).then(function(auth){

                  // Good idea to save the access token to your database
                  botkit.db.slack_users.findOneAndUpdate({
                    id: auth.user_id,
                    team: auth.team_id,
                  },
                  {
                    id: auth.user_id,
                    team: auth.team_id,
                    token: auth.access_token,
                  },
                  {
                    upsert: true,
                    setDefaultsOnInsert: true
                  },
                  function(err) {
                    botkit.db.slack_teams.findOneAndUpdate({
                      id: auth.team_id
                    },{
                      id: auth.team_id,
                      auth: JSON.stringify(auth),
                    },{
                      upsert: true,
                      setDefaultsOnInsert: true
                    }, function(err) {
                      res.redirect(config.login_success_url);
                    });
                  });
              }).catch(function(err) {
                console.error('OAUTH ERROR!!!', err);
                res.redirect('/slack/login');
              });
            }
        },
        {
            url: '/slack/receive',
            method: 'post',
            handler: function(req, res) {
              // is this an events api url handshake?
              if (req.body.type === 'url_verification') {
                  res.json({ challenge: req.body.challenge });
                  return;
              }
              // is this an events api ssl verification?
              if (req.body.ssl_check === '1') {
                  res.json({ ok: true });
                  return;
              }

              var payload = req.body;
              if (payload.payload) {
                  payload = JSON.parse(payload.payload);
              }

              // is this an verified request from slack?
              if (config.clientVerificationToken && payload.token !== config.clientVerificationToken) {
                  debug('Token verification failed, Ignoring message');
                  res.status(401);
                  return;
              }


              // spawn a bot instance to respond to this
              botkit.spawnSlackBot(payload).then(function(bot) {
                bot.http_response = res;
                botkit.receive(bot, payload);
              }).catch(function(err) {
                console.error('Error handling incoming message: ', err);
              });
            }
        },
        ],
        menu: [
            {
              title: 'Slack',
              url: '/admin/slack',
              icon: '💬',
            }
        ],
        middleware: {
            ingest: [
              function(bot, message, next) {
                if (bot.type=='slack') {
                  if (bot.http_response) {
                    bot.http_response.status(200);
                    // conditionally send a response back to Slack to acknowledge the message.
                    // we do NOT want to respond to incoming webhooks or slash commands
                    // as the response can be used by developers to actually deliver a reply
                    if (!message.command && !message.trigger_word && !message.submission) {
                        bot.http_response.send('');
                    }
                  }
                }
                next();
              },
              function(bot, message, next) {
                if (bot.type=='slack') {
                  if (message.callback_id) {

                      // let's normalize some of these fields to match the rtm message format
                      message.user = message.user.id;
                      message.channel = message.channel.id;

                      // put the action value in the text field
                      // this allows button clicks to respond to asks
                      if (message.type == 'interactive_message') {
                          message.text = message.actions[0].value;

                          // handle menus too!
                          // take the first selected item
                          // TODO: When Slack supports multi-select menus, this will need an update!
                          if (message.actions[0].selected_options) {
                              message.text = message.actions[0].selected_options[0].value;
                          }

                          message.type = 'interactive_message_callback';

                      } else if (message.type == 'dialog_submission') {
                          // message.submissions is where the stuff is
                      }
                  }
                }
                next();
              },
              function(bot, message, next) {
                if (bot.type=='slack') {
                  if (message.type == 'event_callback') {

                      // var message = {};
                      for (var key in message.event) {
                          message[key] = message.event[key];
                      }

                      // let's normalize some of these fields to match the rtm message format
                      message.team = message.team_id;
                      message.events_api = true;
                      message.authed_users = message.authed_users;

                      if (bot.config == undefined || bot.config.bot == undefined || bot.config.bot.bot_user_id == null) {
                          console.error('Could not identify bot');
                          return;
                      } else if (bot.config.bot.bot_user_id === message.user && message.subtype !== 'channel_join' && message.subtype !== 'group_join') {
                          // console.error('Got event from this bot user, ignoring it');
                          return;
                      }
                  }
                }
                next();
              },
              function(bot, message, next) {
                if (bot.type == 'slack' && message.type=='reaction_added') {
                  message.channel = message.item.channel;
                }
                next();
              },
              function(bot, message, next) {

                if (bot.type=='slack') {
                  var mentionSyntax = '<@' + bot.config.bot.bot_user_id + '(\\|.*)?>';
                  var mention = new RegExp(mentionSyntax, 'i');
                  var direct_mention = new RegExp('^' + mentionSyntax, 'i');

                  if ('message' == message.type) {

                      if (message.text) {
                          message.text = message.text.trim();
                      }

                      // set up a couple of special cases based on subtype
                      if (message.subtype && message.subtype == 'channel_join') {
                          // someone joined. maybe do something?
                          message.type = 'channel_join';
                      } else if (message.subtype && message.subtype == 'group_join') {
                            message.type = 'group_join';
                      } else if (message.subtype) {
                          message.type = message.subtype;
                      } else if (message.channel.match(/^D/)) {
                          // this is a direct message
                          message.type = 'direct_message';

                          if (!message.text) {
                              // message without text is probably an edit
                              return false;
                          }

                          // remove direct mention so the handler doesn't have to deal with it
                          message.text = message.text.replace(direct_mention, '')
                          .replace(/^\s+/, '').replace(/^\:\s+/, '').replace(/^\s+/, '');


                      } else {
                          if (!message.text) {
                              // message without text is probably an edit
                              return false;
                          }

                          if (message.text.match(direct_mention)) {
                              // this is a direct mention
                              message.text = message.text.replace(direct_mention, '')
                              .replace(/^\s+/, '').replace(/^\:\s+/, '').replace(/^\s+/, '');
                              message.type = 'direct_mention';

                          } else if (message.text.match(mention)) {
                              message.type = 'mention';
                          } else {
                              message.type = 'ambient';
                          }
                      }

                      if (bot.config.bot && bot.config.bot.bot_user_id == message.user) {
                        message.type = 'bot_' + message.type;
                      }

                    }
                }
                next();
              },
            ],
            send: [
              function(bot, message, next) {
                if (bot.type=='slack') {
                  // all good baby
                }
                next();
              }
            ],
            spawn: [
                function(bot, next) {

                    if (bot.type == 'slack') {

                        bot.api = new WebClient(bot.config.bot.bot_access_token);

                        bot.send = function(message) {
                            return new Promise(function(resolve, reject) {
                              bot.api.chat.postMessage(message).then(resolve).catch(reject);
                            });
                        };

                        bot.reply = function(src, resp) {

                            if (typeof(resp) == 'string') {
                                resp = {
                                    text: resp
                                };
                            }
                            resp.user = src.user;
                            resp.channel = src.channel;
                            resp.to = src.user;

                            return bot.say(resp);
                        };
                    }
                    next();

                }
            ],
        },
        init: function(botkit) {

            botkit.db.addModel(slack_team_schema,'slack_team','slack_teams');
            botkit.db.addModel(slack_user_schema,'slack_user','slack_users');

            // make bundled assets available
            // botkit.webserver.use("/plugins/chat", express.static(__dirname + "/public"));

        }
    }

    botkit.spawnSlackBot = function(payload) {

        return new Promise(function(resolve, reject) {
          var found_team = null;

          var team_id = payload.team_id || (payload.team && payload.team.id) || null;
          botkit.db.slack_teams.findOne({id:team_id},function(err, team) {
              if (team) {
                var config = JSON.parse(team.auth);
                botkit.spawn('slack', config).then(resolve).catch(reject);
              } else {
                  if (payload.authed_teams) {
                      async.eachSeries(payload.authed_teams, function(team_id, next) {
                          botkit.db.slack_teams.findOne({id:team_id}, function(err, team) {
                              if (team) {
                                  found_team = team;
                                  next();
                              } else {
                                  next(err);
                              }
                          });
                      }, function(err) {
                          if (!found_team) {
                            reject(err);
                          } else {
                            botkit.spawn('slack', JSON.parse(found_team.auth)).then(resolve).catch(reject);
                          }
                      });
                  } else {
                    reject(`Team ${team_id} not found in slack_teams collection`);
                  }
              }
          });
        });
    };


    // define message types that should be included in conversations
    botkit.listenToEvent('direct_message');
    botkit.listenToEvent('direct_mention');
    botkit.listenToEvent('mention');
    // botkit.listenToEvent('ambient');
    botkit.listenToEvent('interactive_message_callback');

    return plugin;
}
