import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Alert,
  Divider,
  IconButton,
  Card,
  CardContent,
  List,
  ListItem,
  ToggleButton,
  ToggleButtonGroup,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Close as CloseIcon,
  Person as PersonIcon,
  SmartToy as AiIcon,
  Delete as DeleteIcon,
  PlayArrow as PlayArrowIcon,
  Pause as PauseIcon,
  VolumeUp as VolumeUpIcon,
} from '@mui/icons-material';
import { conversationsAPI, agentAPI } from '../services/api';

function CallMonitor() {
  const [conversations, setConversations] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filterMode, setFilterMode] = useState('with_responses'); // 'all', 'with_responses', 'completed'
  const [durationFilter, setDurationFilter] = useState(''); // '', '0-15', '16-30', '31-60', '60+'
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteType, setDeleteType] = useState(null); // 'costs', 'conversations', 'all'
  const [recording, setRecording] = useState(null);
  const [recordingLoading, setRecordingLoading] = useState(false);

  const fetchConversations = useCallback(async () => {
    setLoading(true);
    try {
      // Pass filter mode and duration filter to backend API
      // Duration filter only applies when filterMode is 'completed'
      const durationFilterToSend = filterMode === 'completed' ? durationFilter : null;
      const response = await conversationsAPI.getAll(page + 1, rowsPerPage, filterMode, durationFilterToSend);
      if (response.data.success) {
        setConversations(response.data.conversations);
        setTotalCount(response.data.totalCount);
      }
    } catch (error) {
      console.error('Error fetching conversations:', error);
    } finally {
      setLoading(false);
    }
  }, [page, rowsPerPage, filterMode, durationFilter]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleChangePage = (event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleRowClick = async (conversation) => {
    setSelectedConversation(conversation);
    setDialogOpen(true);
    setRecording(null);
    
    // Use recording from conversation if available, otherwise fetch it
    const callControlId = conversation.callControlId || conversation.call_control_id;
    
    if (conversation.recording && conversation.recording.recording_url) {
      // Use recording already included in conversation object
      setRecording(conversation.recording);
    } else if (callControlId) {
      // Fetch recording if not included
      setRecordingLoading(true);
      try {
        const response = await conversationsAPI.getRecording(callControlId);
        if (response.data.success && response.data.recording) {
          setRecording(response.data.recording);
        }
      } catch (error) {
        // Recording might not exist - that's okay
        console.log('No recording available for this call:', error.message);
      } finally {
        setRecordingLoading(false);
      }
    }
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setSelectedConversation(null);
    setRecording(null);
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'Invalid Date';
    // Convert to EST timezone
    const options = {
      timeZone: 'America/New_York',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    const formatted = date.toLocaleString('en-US', options);
    // Format as MM-DD HH:MM:SS
    const [datePart, timePart] = formatted.split(', ');
    const [month, day] = datePart.split('/');
    return `${month}-${day} ${timePart}`;
  };

  const formatDuration = (seconds) => {
    if (seconds === undefined || seconds === null || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatPhoneNumber = (phone) => {
    if (!phone) return 'N/A';
    // Remove +1 and format as (XXX) XXX-XXXX
    const cleaned = phone.replace(/\D/g, '');
    const match = cleaned.match(/^1?(\d{3})(\d{3})(\d{4})$/);
    if (match) {
      return `(${match[1]}) ${match[2]}-${match[3]}`;
    }
    return phone;
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'completed':
        return 'success';      // Green - successful conversation
      case 'transferred':
        return 'primary';      // Blue - transferred to agent
      case 'active':
        return 'warning';      // Orange - currently active
      case 'voicemail':
        return 'warning';      // Orange - voicemail detected by AMD
      case 'no_response':
        return 'default';      // Grey - AI spoke but no user response
      case 'no_answer':
        return 'default';      // Grey - call never connected
      default:
        return 'default';
    }
  };

  const handleFilterChange = (event, newFilter) => {
    if (newFilter !== null) {
      setFilterMode(newFilter);
      // Reset duration filter when changing away from 'completed'
      if (newFilter !== 'completed') {
        setDurationFilter('');
      }
      setPage(0); // Reset to first page when filter changes
    }
  };

  const handleDurationFilterChange = (event) => {
    setDurationFilter(event.target.value);
    setPage(0); // Reset to first page when duration filter changes
  };

  const handleDeleteClick = (type) => {
    setDeleteType(type);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    try {
      if (deleteType === 'costs') {
        await agentAPI.clearAllCosts();
        alert('✅ All costs deleted successfully!');
      } else if (deleteType === 'conversations') {
        await conversationsAPI.clearAll();
        alert('✅ All conversations deleted successfully!');
      } else if (deleteType === 'all') {
        await agentAPI.clearAllCosts();
        await conversationsAPI.clearAll();
        alert('✅ All costs and conversations deleted successfully!');
      }
      setDeleteDialogOpen(false);
      setDeleteType(null);
      // Refresh the conversations list
      fetchConversations();
    } catch (error) {
      console.error('Error deleting:', error);
      alert(`❌ Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setDeleteType(null);
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" component="h1">
          📞 Call Monitor - Conversation History
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => handleDeleteClick('costs')}
            sx={{ mr: 1 }}
          >
            Delete All Costs
          </Button>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => handleDeleteClick('conversations')}
            sx={{ mr: 1 }}
          >
            Delete All Conversations
          </Button>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => handleDeleteClick('all')}
            sx={{ mr: 1 }}
          >
            Delete All
          </Button>
          <IconButton onClick={fetchConversations} color="primary">
            <RefreshIcon />
          </IconButton>
        </Box>
      </Box>

      {/* Filter Controls */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 'bold' }}>
            Show:
          </Typography>
          <ToggleButtonGroup
            value={filterMode}
            exclusive
            onChange={handleFilterChange}
            size="small"
          >
            <ToggleButton value="with_responses">
              With User Responses
            </ToggleButton>
            <ToggleButton value="completed">
              Completed Only
            </ToggleButton>
            <ToggleButton value="all">
              All Calls
            </ToggleButton>
          </ToggleButtonGroup>
          {filterMode === 'completed' && (
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>Duration</InputLabel>
              <Select
                value={durationFilter}
                label="Duration"
                onChange={handleDurationFilterChange}
              >
                <MenuItem value="">All Durations</MenuItem>
                <MenuItem value="0-15">0s ~ 15s</MenuItem>
                <MenuItem value="16-30">16s ~ 30s</MenuItem>
                <MenuItem value="30-60">30s ~ 60s</MenuItem>
                <MenuItem value="60+">60s+</MenuItem>
              </Select>
            </FormControl>
          )}
          <Chip 
            label={`Showing ${totalCount} conversations`} 
            color="primary" 
            variant="outlined"
            size="small"
          />
        </Box>
        <Typography variant="caption" color="textSecondary" sx={{ display: 'block' }}>
          {filterMode === 'with_responses' && '💬 Showing only conversations where the user actually responded (filters out voicemail/no-answer)'}
          {filterMode === 'completed' && (
            <>
              ✅ Showing only calls marked as completed
              {durationFilter && (
                <span>
                  {' '}• Filtered by duration: {
                    durationFilter === '0-15' ? '0s ~ 15s' :
                    durationFilter === '16-30' ? '16s ~ 30s' :
                    durationFilter === '30-60' ? '30s ~ 60s' :
                    durationFilter === '60+' ? '60s+' : ''
                  }
                </span>
              )}
            </>
          )}
          {filterMode === 'all' && '📋 Showing ALL calls including those where user didn\'t respond'}
        </Typography>
        {filterMode === 'all' && (
          <Typography variant="caption" color="info.main" sx={{ display: 'block', mt: 1 }}>
            ℹ️ Tip: Click any conversation to see the full message history. Special messages (overlapping speech, duplicates, etc.) are shown with colored borders.
          </Typography>
        )}
      </Box>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
              <TableCell><strong>No</strong></TableCell>
              <TableCell><strong>Time (EST)</strong></TableCell>
              <TableCell><strong>From</strong></TableCell>
              <TableCell><strong>To</strong></TableCell>
              <TableCell><strong>Duration</strong></TableCell>
              <TableCell><strong>Cost</strong></TableCell>
              <TableCell><strong>Messages</strong></TableCell>
              <TableCell><strong>Status</strong></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  <Typography>Loading...</Typography>
                </TableCell>
              </TableRow>
            ) : conversations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  <Typography color="textSecondary">No conversations found</Typography>
                </TableCell>
              </TableRow>
            ) : (
              conversations.map((conv, index) => (
                <TableRow
                  key={conv.callControlId}
                  hover
                  onClick={() => handleRowClick(conv)}
                  sx={{ cursor: 'pointer', '&:hover': { backgroundColor: '#f9f9f9' } }}
                >
                  <TableCell>{page * rowsPerPage + index + 1}</TableCell>
                  <TableCell>{formatTime(conv.startTime)}</TableCell>
                  <TableCell>{formatPhoneNumber(conv.fromNumber)}</TableCell>
                  <TableCell>{formatPhoneNumber(conv.toNumber)}</TableCell>
                  <TableCell>{formatDuration(conv.duration)}</TableCell>
                  <TableCell>${(Number(conv.cost) || 0).toFixed(4)}</TableCell>
                  <TableCell>{conv.messages?.length || 0}</TableCell>
                  <TableCell>
                    <Chip
                      label={conv.status}
                      color={getStatusColor(conv.status)}
                      size="small"
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination
          rowsPerPageOptions={[10, 20, 50, 100]}
          component="div"
          count={totalCount}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
        />
      </TableContainer>

      {/* Conversation Detail Modal */}
      <Dialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        maxWidth="md"
        fullWidth
      >
        {selectedConversation && (
          <>
            <DialogTitle>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h6">
                  Conversation Details
                </Typography>
                <IconButton onClick={handleCloseDialog} size="small">
                  <CloseIcon />
                </IconButton>
              </Box>
            </DialogTitle>
            <DialogContent dividers>
              {/* Call Information */}
              <Card sx={{ mb: 2 }}>
                <CardContent>
                  <Typography variant="subtitle1" gutterBottom>
                    <strong>Call Information</strong>
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 2 }}>
                    <Typography variant="body2">
                      <strong>From:</strong> {formatPhoneNumber(selectedConversation.fromNumber)}
                    </Typography>
                    <Typography variant="body2">
                      <strong>To:</strong> {formatPhoneNumber(selectedConversation.toNumber)}
                    </Typography>
                    <Typography variant="body2">
                      <strong>Duration:</strong> {formatDuration(selectedConversation.duration)}
                    </Typography>
                    <Typography variant="body2">
                      <strong>Model:</strong> {selectedConversation.model}
                    </Typography>
                    <Typography variant="body2" component="div">
                      <strong>Status:</strong>{' '}
                      <Chip
                        label={selectedConversation.status}
                        color={getStatusColor(selectedConversation.status)}
                        size="small"
                      />
                    </Typography>
                  </Box>
                  
                  {/* Cost Breakdown */}
                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle2" gutterBottom>
                    <strong>💰 Cost Breakdown</strong>
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    <Typography variant="body2" color="primary">
                      <strong>Telnyx Cost:</strong> ${(Number(selectedConversation.costBreakdown?.telnyx) || 0).toFixed(4)}
                    </Typography>
                    <Typography variant="body2" color="secondary">
                      <strong>OpenAI Cost:</strong> ${(Number(selectedConversation.costBreakdown?.openai) || 0).toFixed(4)}
                    </Typography>
                    <Typography variant="body2" color="warning.main">
                      <strong>ElevenLabs Cost:</strong> ${(Number(selectedConversation.costBreakdown?.elevenlabs) || 0).toFixed(4)}
                    </Typography>
                    <Typography variant="body2" sx={{ gridColumn: '1 / -1', fontWeight: 'bold', color: 'success.main' }}>
                      <strong>Total Cost:</strong> ${(Number(selectedConversation.cost) || 0).toFixed(4)}
                    </Typography>
                  </Box>
                  
                  {/* Detailed Cost Breakdown (if available) */}
                  {selectedConversation.costBreakdown?.details && (
                    <Box sx={{ mt: 2, p: 1.5, backgroundColor: '#f5f5f5', borderRadius: 1 }}>
                      <Typography variant="caption" display="block" gutterBottom>
                        <strong>Telnyx Details:</strong>
                      </Typography>
                      <Box sx={{ pl: 1 }}>
                        <Typography variant="caption" display="block">
                          • Call: ${(Number(selectedConversation.costBreakdown.details.telnyx.callCost) || 0).toFixed(4)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • Transcription (STT): ${(Number(selectedConversation.costBreakdown.details.telnyx.transcriptionCost) || 0).toFixed(4)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • Text-to-Speech: ${(Number(selectedConversation.costBreakdown.details.telnyx.ttsCost) || 0).toFixed(4)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • AMD: ${(Number(selectedConversation.costBreakdown.details.telnyx.amdCost) || 0).toFixed(4)}
                        </Typography>
                        {selectedConversation.costBreakdown.details.telnyx.transferCost > 0 && (
                          <Typography variant="caption" display="block">
                            • Transfer: ${(Number(selectedConversation.costBreakdown.details.telnyx.transferCost) || 0).toFixed(4)}
                          </Typography>
                        )}
                      </Box>
                      
                      <Typography variant="caption" display="block" sx={{ mt: 1 }} gutterBottom>
                        <strong>ElevenLabs Details:</strong>
                      </Typography>
                      <Box sx={{ pl: 1 }}>
                        <Typography variant="caption" display="block">
                          • TTS Cost: ${(Number(selectedConversation.costBreakdown.details.elevenlabs?.ttsCost) || 0).toFixed(4)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • STT Cost: ${(Number(selectedConversation.costBreakdown.details.elevenlabs?.sttCost) || 0).toFixed(4)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • TTS Minutes: {(selectedConversation.costBreakdown.details.elevenlabs?.ttsMinutes || 0).toFixed(2)}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • STT Hours: {(selectedConversation.costBreakdown.details.elevenlabs?.sttHours || 0).toFixed(4)}
                        </Typography>
                      </Box>
                      
                      <Typography variant="caption" display="block" sx={{ mt: 1 }} gutterBottom>
                        <strong>OpenAI Details:</strong>
                      </Typography>
                      <Box sx={{ pl: 1 }}>
                        <Typography variant="caption" display="block">
                          • Input Tokens: {selectedConversation.costBreakdown.details.openai?.inputTokens || 0}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • Output Tokens: {selectedConversation.costBreakdown.details.openai?.outputTokens || 0}
                        </Typography>
                        <Typography variant="caption" display="block">
                          • API Calls: {selectedConversation.costBreakdown.details.openai?.apiCalls || 0}
                        </Typography>
                      </Box>
                    </Box>
                  )}
                </CardContent>
              </Card>

              {/* Call Recording */}
              {recordingLoading ? (
                <Card sx={{ mb: 2 }}>
                  <CardContent>
                    <Typography variant="body2" color="textSecondary">
                      Loading recording...
                    </Typography>
                  </CardContent>
                </Card>
              ) : recording && recording.recording_url && recording.status === 'saved' ? (
                <Card sx={{ mb: 2 }}>
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                      <VolumeUpIcon color="primary" />
                      <Typography variant="subtitle1">
                        <strong>Call Recording</strong>
                      </Typography>
                    </Box>
                    {recording.duration_seconds && (
                      <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                        Duration: {formatDuration(recording.duration_seconds)}
                      </Typography>
                    )}
                    <Box sx={{ width: '100%' }}>
                      <audio 
                        controls 
                        style={{ width: '100%' }}
                        src={recording.recording_url}
                        preload="metadata"
                      >
                        Your browser does not support the audio element.
                      </audio>
                    </Box>
                    {recording.recording_started_at && (
                      <Typography variant="caption" color="textSecondary" display="block" sx={{ mt: 1 }}>
                        Recorded at: {formatTime(recording.recording_started_at)}
                      </Typography>
                    )}
                  </CardContent>
                </Card>
              ) : recording && recording.status === 'failed' ? (
                <Card sx={{ mb: 2, border: '1px solid', borderColor: 'error.main' }}>
                  <CardContent>
                    <Typography variant="body2" color="error">
                      Recording failed: {recording.error_message || 'Unknown error'}
                    </Typography>
                  </CardContent>
                </Card>
              ) : recording && recording.status === 'pending' ? (
                <Card sx={{ mb: 2 }}>
                  <CardContent>
                    <Typography variant="body2" color="textSecondary">
                      Recording is being processed...
                    </Typography>
                  </CardContent>
                </Card>
              ) : null}

              {/* Conversation Script */}
              <Typography variant="subtitle1" gutterBottom>
                <strong>Conversation Script</strong>
              </Typography>
              
              {/* Legend for special message types */}
              <Box sx={{ mb: 2, p: 1.5, backgroundColor: '#f5f5f5', borderRadius: 1 }}>
                <Typography variant="caption" display="block" gutterBottom>
                  <strong>Message Indicators:</strong>
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  <Chip label="🔶 Overlapping Speech" size="small" sx={{ opacity: 0.8, borderLeft: '4px solid #ff9800' }} />
                  <Chip label="🔴 Low Confidence" size="small" sx={{ opacity: 0.8, borderLeft: '4px solid #ff5722' }} />
                  <Chip label="⚫ Duplicate" size="small" sx={{ opacity: 0.8, borderLeft: '4px solid #9e9e9e' }} />
                  <Chip label="🟣 After Call End" size="small" sx={{ opacity: 0.8, borderLeft: '4px solid #9c27b0' }} />
                  <Chip label="🔵 AMD Detection" size="small" sx={{ opacity: 0.8, borderLeft: '4px solid #2196f3' }} />
                </Box>
              </Box>
              
              <Paper sx={{ p: 2, maxHeight: '400px', overflow: 'auto', backgroundColor: '#fafafa' }}>
                <List>
                  {selectedConversation.messages && selectedConversation.messages.length > 0 ? (
                    selectedConversation.messages.map((message, index) => {
                      // Check for special message types
                      const isOverlapping = message.text.startsWith('[Overlapping speech]');
                      const isLowConfidence = message.text.match(/^\[Low confidence \d+%\]/);
                      const isDuplicate = message.text.startsWith('[Duplicate]');
                      const isAfterCallEnd = message.text.startsWith('[After call end]');
                      const isAMD = message.text.startsWith('[AMD Detection:');
                      
                      const isSpecial = isOverlapping || isLowConfidence || isDuplicate || isAfterCallEnd || isAMD;
                      
                      // Determine background color and opacity
                      let backgroundColor = message.speaker === 'AI' ? '#e3f2fd' : '#fff3e0';
                      let opacity = 1;
                      let borderLeft = 'none';
                      
                      if (isSpecial) {
                        opacity = 0.6;
                        if (isOverlapping) borderLeft = '4px solid #ff9800';
                        else if (isLowConfidence) borderLeft = '4px solid #ff5722';
                        else if (isDuplicate) borderLeft = '4px solid #9e9e9e';
                        else if (isAfterCallEnd) borderLeft = '4px solid #9c27b0';
                        else if (isAMD) borderLeft = '4px solid #2196f3';
                      }
                      
                      return (
                        <React.Fragment key={index}>
                          <ListItem
                            sx={{
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              backgroundColor,
                              opacity,
                              borderLeft,
                              borderRadius: 1,
                              mb: 1,
                              p: 2,
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                              {message.speaker === 'AI' ? (
                                <AiIcon sx={{ mr: 1, color: '#1976d2' }} />
                              ) : (
                                <PersonIcon sx={{ mr: 1, color: '#ff9800' }} />
                              )}
                              <Typography variant="subtitle2" color="textSecondary">
                                <strong>{message.speaker}</strong> •{' '}
                                {new Date(message.timestamp).toLocaleTimeString()}
                              </Typography>
                            </Box>
                            <Typography variant="body2" sx={{ pl: 4 }}>
                              {message.text}
                            </Typography>
                          </ListItem>
                          {index < selectedConversation.messages.length - 1 && <Divider />}
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <Typography variant="body2" color="textSecondary" align="center">
                      No messages in this conversation
                    </Typography>
                  )}
                </List>
              </Paper>
            </DialogContent>
            <DialogActions>
              <Button onClick={handleCloseDialog} variant="contained">
                Close
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={handleDeleteCancel}>
        <DialogTitle>
          Confirm Delete
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {deleteType === 'costs' && 'Are you sure you want to delete ALL cost records? This action cannot be undone.'}
            {deleteType === 'conversations' && 'Are you sure you want to delete ALL conversation records? This action cannot be undone.'}
            {deleteType === 'all' && 'Are you sure you want to delete ALL costs and conversations? This action cannot be undone.'}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel} color="primary">
            Cancel
          </Button>
          <Button onClick={handleDeleteConfirm} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default CallMonitor;
