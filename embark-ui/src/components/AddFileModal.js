import React from 'react';
import {Button, Modal, ModalHeader, ModalBody, ModalFooter, Input} from 'reactstrap';
import PropTypes from 'prop-types';
import classNames from 'classnames';

import {isDarkTheme} from '../utils/utils';

class AddFileModal extends React.Component {
  constructor(props) {
    super(props)
    this.state = {modal: false, filename: ''};
  }

  toggle() {
    this.setState({modal: !this.state.modal});
  }

  handleChange(event) {
    this.setState({filename: event.target.value});
  }

  addFile() {
    this.props.saveFile({path: `${this.props.node.path}/${this.state.filename}`, content: ''});
    this.toggle();
  }

  render() {
    return (
      <Modal contentClassName={classNames({'dark-theme': isDarkTheme(this.props.theme)})}
             isOpen={this.state.modal}
             toggle={() => this.toggle()}>
        <ModalHeader toggle={() => this.toggle()}>Please give the file a name</ModalHeader>
        <ModalBody>
          <Input autofocus="true" value={this.state.filename} onChange={e => this.handleChange(e)} />
        </ModalBody>
        <ModalFooter>
          <Button color="primary" onClick={() => this.addFile()}>Add File</Button>{' '}
          <Button color="secondary" onClick={() => this.toggle()}>Cancel</Button>
        </ModalFooter>
      </Modal>
    )
  }
}

AddFileModal.propTypes = {
  saveFile: PropTypes.func,
  node: PropTypes.object,
  theme: PropTypes.string
};

export default AddFileModal;