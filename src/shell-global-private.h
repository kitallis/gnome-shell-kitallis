/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */
#ifndef __SHELL_GLOBAL_PRIVATE_H__
#define __SHELL_GLOBAL_PRIVATE_H__

#include "shell-global.h"

#include <gjs/gjs.h>

void _shell_global_set_plugin      (ShellGlobal  *global,
                                    MetaPlugin   *plugin);

GjsContext *_shell_global_get_gjs_context (ShellGlobal  *global);

gboolean _shell_global_check_xdnd_event (ShellGlobal  *global,
                                         XEvent       *xev);
#endif /* __SHELL_GLOBAL_PRIVATE_H__ */
