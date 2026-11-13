// The names of the Jira tools the extension offers to Copilot. Kept apart from the catalog so that tool
// modules and the message text they build can name another tool without importing the catalog,
// which imports them; any text that points an agent at a tool takes the name from here.

export const CHECK_CONNECTION_TOOL = 'jira_check_connection';
export const VIEW_TICKET_TOOL = 'jira_view_ticket';
export const FIND_TICKETS_TOOL = 'jira_find_tickets';
export const LIST_MY_FILTERS_TOOL = 'jira_list_my_filters';
export const WORKFLOW_TOOL = 'jira_workflow';
export const LIST_TEMPLATES_TOOL = 'jira_list_templates';
export const LOAD_TICKET_TOOL = 'jira_load_ticket';
export const MOVE_TICKET_TOOL = 'jira_move_ticket';
export const CREATE_TICKET_TOOL = 'jira_create_ticket';
export const ADD_COMMENT_TOOL = 'jira_add_comment';
export const UPDATE_FIELD_TOOL = 'jira_update_field';
export const UPLOAD_ATTACHMENT_TOOL = 'jira_upload_attachment';
export const LIST_FIELDS_TOOL = 'jira_list_fields';
export const CHECK_REQUIRED_FIELDS_TOOL = 'jira_check_required_fields';
export const OPEN_BOARD_TOOL = 'jira_open_board';
